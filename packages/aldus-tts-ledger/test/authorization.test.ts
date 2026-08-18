/**
 * Paid synthesis authorization (architecture contract §13.2, §15.1).
 *
 * §24 makes one of these a condition of V1 being done: "paid TTS cannot execute without valid
 * hash-bound authorization". §1.1 names the failure it guards against — duplicate or unnecessary
 * paid TTS requests.
 *
 * The ledger cannot execute anything, so what it must guarantee is narrower and still load-
 * bearing: it must never record a charge as authorized when the authorization does not hold. A
 * ledger that did would leave an operator reading a trace that says spend was approved when it
 * was not, which is worse than no trace at all.
 */

import { AldusError } from "@aldus-runtime/core";
import { beforeEach, describe, expect, it } from "vitest";

import { TtsLedgerErrorCodes } from "../src/errors.js";
import { TtsLedger } from "../src/ledger.js";
import {
  MemoryLedgerEventSink,
  MemoryPlanStore,
  MemoryScriptStore,
  MemoryTakeStore,
  type SpendAuthorizer,
} from "../src/ports.js";
import { planScopeDigest } from "../src/request.js";
import {
  ApprovingAuthorizer,
  EPISODE_ID,
  OPERATOR,
  PLAN_ID,
  paidTake,
  plan,
  RefusingAuthorizer,
  RUN_ID,
  WORKER,
} from "./helpers.js";

function makeLedger(authorizer?: SpendAuthorizer) {
  const takes = new MemoryTakeStore();
  const plans = new MemoryPlanStore();
  const events = new MemoryLedgerEventSink();
  const ledger = new TtsLedger({
    takes,
    plans,
    scripts: new MemoryScriptStore(),
    events,
    ...(authorizer === undefined ? {} : { authorizer }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { ledger, takes, plans, events };
}

async function caught(operation: () => Promise<unknown>): Promise<AldusError> {
  try {
    await operation();
  } catch (error) {
    return error as AldusError;
  }
  throw new Error("expected the operation to be refused, but it succeeded");
}

describe("permitSynthesis (§13.2)", () => {
  it("refuses when no authorizer is wired at all", async () => {
    // A ledger with nothing to ask must refuse rather than assume consent. Defaulting to
    // "permitted" would make an integration that forgot to wire the gate engine spend freely.
    const { ledger } = makeLedger();
    const permission = await ledger.permitSynthesis(plan());
    expect(permission.permitted).toBe(false);
    if (permission.permitted) return;
    expect(permission.explanation).toContain("§13.2");
  });

  it("refuses when the authorizer says the gate is not satisfied", async () => {
    const { ledger } = makeLedger(new RefusingAuthorizer());
    const permission = await ledger.permitSynthesis(plan());
    expect(permission.permitted).toBe(false);
  });

  it("permits when the gate is satisfied, and relays which decision authorized it", async () => {
    const { ledger } = makeLedger(new ApprovingAuthorizer("dec-a"));
    const permission = await ledger.permitSynthesis(plan());
    expect(permission.permitted).toBe(true);
    if (!permission.permitted) return;
    expect(permission.authorization.decisionId).toBe("dec-a");
  });

  it("passes every digest §13.2 requires an approval to bind", async () => {
    const seen: Record<string, string>[] = [];
    const spy: SpendAuthorizer = {
      authorize: (request) => {
        seen.push(request.subjectDigests);
        return Promise.resolve({
          authorized: true,
          gateId: "performance-freeze",
          decisionId: "dec-a",
          planScopeSha256: request.planScopeSha256,
        });
      },
    };
    const { ledger } = makeLedger(spy);
    await ledger.permitSynthesis(plan());

    // §13.2: spoken-text hash, PerformanceScript hash, voice/model/settings, request plan.
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "performanceScript",
      "requestPlan",
      "spokenText",
      "synthesisParameters",
    ]);
  });
});

describe("recordTake refuses an unauthorized charge (§13.2)", () => {
  let ctx: ReturnType<typeof makeLedger>;

  beforeEach(async () => {
    ctx = makeLedger(new ApprovingAuthorizer());
    await ctx.ledger.recordPlan(plan(), EPISODE_ID, OPERATOR);
  });

  it("records a paid take when the authorization holds", async () => {
    const take = await ctx.ledger.recordTake({
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      take: paidTake(plan()),
      episodeId: EPISODE_ID,
      actor: WORKER,
    });
    expect(take.attempt).toBe(1);
    expect(await ctx.ledger.listTakes(RUN_ID)).toHaveLength(1);
  });

  it("refuses a take that records a cost but cites no authorization", async () => {
    const { authorization: _dropped, ...unauthorized } = paidTake(plan());
    const error = await caught(() =>
      ctx.ledger.recordTake({
        runId: RUN_ID,
        planId: PLAN_ID,
        segmentId: "seg-1",
        take: unauthorized,
        episodeId: EPISODE_ID,
        actor: WORKER,
      }),
    );
    expect(error.code).toBe(TtsLedgerErrorCodes.UNAUTHORIZED_CHARGE);
    expect(error.retryable).toBe(false);
    expect(await ctx.ledger.listTakes(RUN_ID)).toHaveLength(0);
  });

  it("refuses when the gate has gone stale since the request was made", async () => {
    const stale = makeLedger(new RefusingAuthorizer());
    await stale.ledger.recordPlan(plan(), EPISODE_ID, OPERATOR);
    const error = await caught(() =>
      stale.ledger.recordTake({
        runId: RUN_ID,
        planId: PLAN_ID,
        segmentId: "seg-1",
        take: paidTake(plan()),
        episodeId: EPISODE_ID,
        actor: WORKER,
      }),
    );
    expect(error.code).toBe(TtsLedgerErrorCodes.UNAUTHORIZED_CHARGE);
  });

  it("refuses an authorization issued by a superseded decision", async () => {
    // The gate is satisfied — but by a *different, later* decision than the one the take cites.
    // §13.2: an authorization from a superseded decision does not carry forward.
    const superseded = makeLedger(new ApprovingAuthorizer("dec-b"));
    await superseded.ledger.recordPlan(plan(), EPISODE_ID, OPERATOR);
    const error = await caught(() =>
      superseded.ledger.recordTake({
        runId: RUN_ID,
        planId: PLAN_ID,
        segmentId: "seg-1",
        take: paidTake(plan()),
        episodeId: EPISODE_ID,
        actor: WORKER,
      }),
    );
    expect(error.code).toBe(TtsLedgerErrorCodes.UNAUTHORIZED_CHARGE);
    expect(error.details).toMatchObject({ citedDecisionId: "dec-a", currentDecisionId: "dec-b" });
  });

  it("refuses when the authorization covered a different request plan", async () => {
    // The approval is live, but it approved a plan whose scope has since changed. This is the
    // substitution §13.2's plan binding exists to catch: approve a cheap two-segment request,
    // then synthesise something else under the same decision.
    const error = await caught(() =>
      ctx.ledger.recordTake({
        runId: RUN_ID,
        planId: PLAN_ID,
        segmentId: "seg-1",
        take: paidTake(plan(), {
          authorization: {
            gateId: "performance-freeze",
            decisionId: "dec-a",
            planScopeSha256: "0".repeat(64),
          },
        }),
        episodeId: EPISODE_ID,
        actor: WORKER,
      }),
    );
    expect(error.code).toBe(TtsLedgerErrorCodes.PLAN_MISMATCH);
  });

  it("does not require authorization for an unpaid take (§15.1 human-recorded replacement)", async () => {
    // §15.1 lists "human-recorded replacement" among repair strategies. Nobody was billed, so
    // demanding a spend authorization would block a repair that costs nothing.
    const take = await ctx.ledger.recordTake({
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      take: {
        segmentId: "seg-1",
        text: { raw: "The first thing to know is simple." },
        parameters: { provider: "local", voice: "voice-a", model: "model-a" },
      },
      episodeId: EPISODE_ID,
      actor: OPERATOR,
    });
    expect(take.authorization).toBeUndefined();
  });

  it("refuses a take against a plan the ledger never recorded", async () => {
    const error = await caught(() =>
      ctx.ledger.recordTake({
        runId: RUN_ID,
        planId: "plan-never-seen",
        segmentId: "seg-1",
        take: paidTake(plan()),
        episodeId: EPISODE_ID,
        actor: WORKER,
      }),
    );
    expect(error.code).toBe(TtsLedgerErrorCodes.NOT_FOUND);
  });
});

describe("plan digests (§13.2)", () => {
  it("changing the spoken text changes the plan scope", async () => {
    const before = planScopeDigest(plan());
    const after = planScopeDigest(
      plan({
        segments: [
          { segmentId: "seg-1", text: { raw: "Something else entirely." } },
          { segmentId: "seg-2", text: { raw: "The second thing is less so." } },
        ],
      }),
    );
    expect(after).not.toBe(before);
  });

  it("changing the voice changes the plan scope", () => {
    const before = planScopeDigest(plan());
    const after = planScopeDigest(
      plan({ parameters: { provider: "provider-a", voice: "voice-b", model: "model-a" } }),
    );
    expect(after).not.toBe(before);
  });

  it("re-planning identically does not change the scope", () => {
    // A plan rebuilt after a restart must not read as a different request, or every resume would
    // demand re-approval. `planId` and `createdAt` are excluded for exactly this reason.
    expect(planScopeDigest(plan({ planId: "plan-b", createdAt: "2026-02-02T00:00:00.000Z" }))).toBe(
      planScopeDigest(plan()),
    );
  });

  it("a revised cost estimate does not void the freeze", () => {
    // The ceiling is bound separately by the spend grant (gate engine, ADR-0009). A provider
    // revising its estimate must not silently void a Performance Freeze.
    expect(planScopeDigest(plan({ estimatedTotal: { amount: "9.9900", currency: "USD" } }))).toBe(
      planScopeDigest(plan()),
    );
  });
});

describe("recordUnauthorizedCharge captures spend the ledger would otherwise lose (§13.2, §20)", () => {
  // recordTake refusing an unauthorized charge does not stop the spend — the money is already
  // gone by the time the ledger hears about it. Refusal only stops the ledger *asserting* the
  // spend was authorized. But refusal alone leaves a worse hole: §20 requires the production
  // trace to answer "what it cost", and a charge that happened yet appears nowhere is its own
  // harm. These tests pin the escape hatch, and that it stays visibly an escape hatch.
  let ctx: ReturnType<typeof makeLedger>;

  beforeEach(async () => {
    ctx = makeLedger(new RefusingAuthorizer());
    await ctx.ledger.recordPlan(plan(), EPISODE_ID, OPERATOR);
  });

  it("records a charge the ordinary path refuses", async () => {
    const { authorization: _dropped, ...unauthorized } = paidTake(plan());

    // The ordinary path refuses, leaving the charge unrecorded.
    const refusal = await caught(() =>
      ctx.ledger.recordTake({
        runId: RUN_ID,
        planId: PLAN_ID,
        segmentId: "seg-1",
        take: unauthorized,
        episodeId: EPISODE_ID,
        actor: WORKER,
      }),
    );
    expect(refusal.code).toBe(TtsLedgerErrorCodes.UNAUTHORIZED_CHARGE);
    expect(await ctx.ledger.listTakes(RUN_ID)).toHaveLength(0);

    const take = await ctx.ledger.recordUnauthorizedCharge({
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      take: unauthorized,
      episodeId: EPISODE_ID,
      actor: OPERATOR,
      reason: "A worker called the provider without checking permitSynthesis.",
    });

    expect(await ctx.ledger.listTakes(RUN_ID)).toHaveLength(1);
    expect(take.unauthorizedCharge?.reason).toContain("without checking");
    expect(take.unauthorizedCharge?.acknowledgedBy).toEqual(OPERATOR);
  });

  it("marks the record plainly rather than laundering it into an ordinary take", async () => {
    const { authorization: _dropped, ...unauthorized } = paidTake(plan());
    const take = await ctx.ledger.recordUnauthorizedCharge({
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      take: unauthorized,
      episodeId: EPISODE_ID,
      actor: OPERATOR,
      reason: "Recovered from provider billing after the fact.",
    });

    // The marker is the whole point: without it this is indistinguishable from an authorized
    // charge, and recording it would be worse than refusing.
    expect(take.unauthorizedCharge).toBeDefined();
    expect(take.authorization).toBeUndefined();
  });

  it("emits a distinct event so an unauthorized charge is greppable in the log", async () => {
    const { authorization: _dropped, ...unauthorized } = paidTake(plan());
    await ctx.ledger.recordUnauthorizedCharge({
      runId: RUN_ID,
      planId: PLAN_ID,
      segmentId: "seg-1",
      take: unauthorized,
      episodeId: EPISODE_ID,
      actor: OPERATOR,
      reason: "Charge discovered during reconciliation.",
    });

    const actions = ctx.events.events.map((event) => event.action);
    expect(actions).toContain("tts.charge.unauthorized");
  });

  it("still refuses an ordinary paid take, so the hatch is not a bypass", async () => {
    const { authorization: _dropped, ...unauthorized } = paidTake(plan());
    const error = await caught(() =>
      ctx.ledger.recordTake({
        runId: RUN_ID,
        planId: PLAN_ID,
        segmentId: "seg-2",
        take: unauthorized,
        episodeId: EPISODE_ID,
        actor: WORKER,
      }),
    );
    expect(error.code).toBe(TtsLedgerErrorCodes.UNAUTHORIZED_CHARGE);
  });
});
