/**
 * Take retention and lineage (architecture contract §15.1, §15, §12.4).
 *
 * §15.1: "Rejected paid takes SHOULD be retained with unique identity until retention policy
 * allows cleanup." §1.1 lists "loss or overwrite of accepted audio takes" among the failures V1
 * must reduce.
 *
 * A rejected take is not garbage. It is the evidence that a particular voice mispronounces a
 * particular name, which is what makes the defect findable again (WP-10) and what tells an
 * operator which repair rung to try next (§12.4). A ledger that pruned to "the one that worked"
 * would throw away the reason the working one was reachable.
 */

import { AldusError } from "@aldus/core";
import { beforeEach, describe, expect, it } from "vitest";

import { TtsLedgerErrorCodes } from "../src/errors.js";
import { TtsLedger, repairFor } from "../src/ledger.js";
import { buildLineage, acceptedTakeFor, segmentsAwaitingAcceptance } from "../src/lineage.js";
import {
  MemoryLedgerEventSink,
  MemoryPlanStore,
  MemoryScriptStore,
  MemoryTakeStore,
} from "../src/ports.js";
import {
  REPAIR_RUNGS,
  invalidatesContentFreeze,
  repairRungOrder,
  takeRecordSchema,
  type TakeRecord,
} from "../src/take.js";
import {
  ApprovingAuthorizer,
  AT,
  EPISODE_ID,
  OPERATOR,
  PLAN_ID,
  paidTake,
  plan,
  RUN_ID,
  WORKER,
} from "./helpers.js";

function makeLedger() {
  const takes = new MemoryTakeStore();
  const ledger = new TtsLedger({
    takes,
    plans: new MemoryPlanStore(),
    scripts: new MemoryScriptStore(),
    events: new MemoryLedgerEventSink(),
    authorizer: new ApprovingAuthorizer(),
    now: () => new Date(AT),
  });
  return { ledger, takes };
}

async function caught(operation: () => Promise<unknown>): Promise<AldusError> {
  try {
    await operation();
  } catch (error) {
    return error as AldusError;
  }
  throw new Error("expected the operation to be refused, but it succeeded");
}

describe("rejected takes are retained (§15.1)", () => {
  let ledger: TtsLedger;

  beforeEach(async () => {
    ({ ledger } = makeLedger());
    await ledger.recordPlan(plan(), EPISODE_ID, OPERATOR);
  });

  it("keeps a rejected take addressable after a replacement is accepted", async () => {
    const first = await ledger.recordTake({
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      take: paidTake(plan(), { takeId: "take-1" }),
      episodeId: EPISODE_ID,
      actor: WORKER,
    });
    await ledger.decideTake(
      RUN_ID,
      first.takeId,
      {
        decision: "rejected",
        decidedBy: "operator-a",
        decidedAt: AT,
        reason: "The named entity in the second clause was mispronounced.",
        findings: ["pronunciation/named-entity"],
      },
      EPISODE_ID,
    );

    const second = await ledger.recordTake({
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      take: paidTake(plan(), {
        takeId: "take-2",
        supersedes: "take-1",
        repair: repairFor("regenerate_segment", "Retry after adding a lexicon entry."),
      }),
      episodeId: EPISODE_ID,
      actor: WORKER,
    });
    await ledger.decideTake(
      RUN_ID,
      second.takeId,
      { decision: "accepted", decidedBy: "operator-a", decidedAt: AT },
      EPISODE_ID,
    );

    const all = await ledger.listTakes(RUN_ID);
    expect(all).toHaveLength(2);

    // The rejected take is still there, still identifiable, and still carries why it failed.
    const rejected = all.find((take) => take.takeId === "take-1");
    expect(rejected?.decision?.decision).toBe("rejected");
    expect(rejected?.decision?.reason).toContain("mispronounced");
    expect(rejected?.audioSha256).toBeDefined();
  });

  it("has no way to delete a take at all", () => {
    // §15.1 is a retention requirement, and the strongest form of it is a store interface with
    // no delete to call. If this ever gains one, retention becomes a convention again.
    const store = new MemoryTakeStore();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort()).toEqual([
      "append",
      "constructor",
      "list",
      "replace",
    ]);
  });

  it("refuses to overwrite a decision, so the rejection cannot be edited away", async () => {
    const take = await ledger.recordTake({
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      take: paidTake(plan(), { takeId: "take-1" }),
      episodeId: EPISODE_ID,
      actor: WORKER,
    });
    await ledger.decideTake(
      RUN_ID,
      take.takeId,
      { decision: "rejected", decidedBy: "operator-a", decidedAt: AT, reason: "Too fast." },
      EPISODE_ID,
    );

    const error = await caught(() =>
      ledger.decideTake(
        RUN_ID,
        take.takeId,
        { decision: "accepted", decidedBy: "operator-b", decidedAt: AT },
        EPISODE_ID,
      ),
    );
    expect(error.code).toBe(TtsLedgerErrorCodes.TAKE_ALREADY_DECIDED);

    const stored = (await ledger.listTakes(RUN_ID))[0];
    expect(stored?.decision?.decision).toBe("rejected");
  });

  it("requires a reason on a rejection but not on an acceptance", () => {
    const base = {
      schemaVersion: "1.2",
      takeId: "take-1",
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      attempt: 1,
      text: { raw: "Something." },
      parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
      recordedAt: AT,
    };
    // A rejection with no reason cannot become a repair strategy (§15.1) or a corpus case (WP-10).
    expect(
      takeRecordSchema.safeParse({
        ...base,
        decision: { decision: "rejected", decidedBy: "operator-a", decidedAt: AT },
      }).success,
    ).toBe(false);
    expect(
      takeRecordSchema.safeParse({
        ...base,
        decision: { decision: "accepted", decidedBy: "operator-a", decidedAt: AT },
      }).success,
    ).toBe(true);
  });
});

describe("the repair ladder (§12.4)", () => {
  it("orders rungs smallest safe layer first", () => {
    // §12.4's own order. Reversing it would make "prefer the smallest safe layer" advice that
    // points the wrong way.
    expect([...REPAIR_RUNGS]).toEqual([
      "regenerate_segment",
      "provider_mapping",
      "performance_script",
      "narration_rewrite",
      "escalate_human",
    ]);
    expect(repairRungOrder("regenerate_segment")).toBeLessThan(
      repairRungOrder("narration_rewrite"),
    );
  });

  it("marks only a narration rewrite as content-changing (§13.1)", () => {
    // §13.1: any content-changing edit invalidates Content Freeze and downstream approvals.
    // Regenerating a segment or remapping provider settings changes no approved claim.
    expect(invalidatesContentFreeze("narration_rewrite")).toBe(true);
    for (const rung of REPAIR_RUNGS.filter((candidate) => candidate !== "narration_rewrite")) {
      expect(invalidatesContentFreeze(rung), rung).toBe(false);
    }
  });

  it("requires a superseding take to say which layer it repaired at", () => {
    // A retry that does not record its rung tells an operator that something was tried again but
    // not what changed — which is exactly what §12.4 asks a repair to identify.
    const withoutRepair = {
      schemaVersion: "1.2",
      takeId: "take-2",
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      attempt: 2,
      text: { raw: "Something." },
      parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
      recordedAt: AT,
      supersedes: "take-1",
    };
    expect(takeRecordSchema.safeParse(withoutRepair).success).toBe(false);
    expect(
      takeRecordSchema.safeParse({
        ...withoutRepair,
        repair: { rung: "provider_mapping", reason: "Lowered stability." },
      }).success,
    ).toBe(true);
  });
});

describe("lineage", () => {
  const take = (overrides: Partial<TakeRecord>): TakeRecord =>
    ({
      schemaVersion: "1.2",
      takeId: "take-x",
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      attempt: 1,
      text: { raw: "Something." },
      parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
      recordedAt: AT,
      ...overrides,
    }) as TakeRecord;

  it("orders a chain oldest-first by following supersedes, not timestamps", () => {
    // Timestamps say when a record was written; the chain says what replaced what. After an
    // out-of-order write those disagree, and the chain is the one that is still true.
    const takes = [
      take({
        takeId: "c",
        attempt: 3,
        supersedes: "b",
        repair: { rung: "regenerate_segment", reason: "r" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      }),
      take({ takeId: "a", attempt: 1, recordedAt: "2026-01-01T00:00:09.000Z" }),
      take({
        takeId: "b",
        attempt: 2,
        supersedes: "a",
        repair: { rung: "provider_mapping", reason: "r" },
        recordedAt: "2026-01-01T00:00:05.000Z",
      }),
    ];
    const lineage = buildLineage(takes).get("seg-1");
    expect(lineage?.takes.map((entry) => entry.takeId)).toEqual(["a", "b", "c"]);
    expect(lineage?.repairPath).toEqual(["provider_mapping", "regenerate_segment"]);
  });

  it("separates accepted, rejected, and undecided takes", () => {
    const takes = [
      take({
        takeId: "a",
        decision: { decision: "rejected", decidedBy: "o", decidedAt: AT, reason: "no" },
      }),
      take({
        takeId: "b",
        attempt: 2,
        supersedes: "a",
        repair: { rung: "regenerate_segment", reason: "r" },
        decision: { decision: "accepted", decidedBy: "o", decidedAt: AT },
      }),
      take({ takeId: "c", segmentId: "seg-2" }),
    ];
    const first = buildLineage(takes).get("seg-1");
    expect(first?.accepted?.takeId).toBe("b");
    expect(first?.rejected.map((entry) => entry.takeId)).toEqual(["a"]);
    expect(
      buildLineage(takes)
        .get("seg-2")
        ?.undecided.map((entry) => entry.takeId),
    ).toEqual(["c"]);
  });

  it("reports a cycle instead of looping forever", () => {
    // Impossible in correct data — a take supersedes an earlier take, so the chain runs backwards
    // in time. A query that hung on corrupt data would be worse than one that says so.
    const takes = [
      take({ takeId: "a", supersedes: "b", repair: { rung: "regenerate_segment", reason: "r" } }),
      take({ takeId: "b", supersedes: "a", repair: { rung: "regenerate_segment", reason: "r" } }),
    ];
    let error: AldusError | undefined;
    try {
      buildLineage(takes);
    } catch (thrown) {
      error = thrown as AldusError;
    }
    expect(error?.code).toBe(TtsLedgerErrorCodes.LINEAGE_CYCLE);
  });

  it("keeps a take whose predecessor is missing rather than dropping it", () => {
    // A partially written chain must not lose a paid take to a bookkeeping gap — that would be
    // the §15.1 retention failure arriving through the back door.
    const takes = [
      take({
        takeId: "orphan",
        attempt: 2,
        supersedes: "never-written",
        repair: { rung: "regenerate_segment", reason: "r" },
      }),
    ];
    expect(
      buildLineage(takes)
        .get("seg-1")
        ?.takes.map((entry) => entry.takeId),
    ).toEqual(["orphan"]);
  });

  it("reports which segments still need a human ear (§13.3)", () => {
    const takes = [
      take({ takeId: "a", decision: { decision: "accepted", decidedBy: "o", decidedAt: AT } }),
      take({ takeId: "b", segmentId: "seg-2" }),
    ];
    expect(acceptedTakeFor(takes, "seg-1")?.takeId).toBe("a");
    expect(segmentsAwaitingAcceptance(takes, ["seg-1", "seg-2", "seg-3"])).toEqual([
      "seg-2",
      "seg-3",
    ]);
  });
});
