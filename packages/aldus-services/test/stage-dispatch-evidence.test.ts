/**
 * `SpendService.stageDispatchEvidence` against a real store on a real filesystem (#244, ADR-0044).
 *
 * The Core rule has its own unit tests. What this file is about is the half only a real store can
 * exhibit: which grants get read, what a real `reserve` writes into a reservation's `attemptId`
 * after a retry, and what happens when a stream refuses to be read. A double agreeing with the
 * store would assert the double.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CostRecord } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";
import type { SpendGrant } from "@aldus-runtime/gate-engine";

import type { CostRecordStore } from "../src/cost-store.js";
import { SpendService } from "../src/spend-service.js";

const RUN = "run-a";
const STAGE = "outline.draft";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aldus-244-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function grant(overrides: Partial<SpendGrant> = {}): SpendGrant {
  return {
    grantId: "grant-agent",
    runId: RUN,
    gateId: "agent.spend",
    decisionId: "decision-a",
    scope: { operations: ["agent.execute"] },
    maxTotal: { amount: "100.0000", currency: "USD" },
    maxPerRequest: { amount: "50.0000", currency: "USD" },
    ...overrides,
  };
}

function costStore(): CostRecordStore & { records: CostRecord[] } {
  const records: CostRecord[] = [];
  return {
    records,
    list: () => Promise.resolve([...records]),
    append: (_runId, record) => {
      if (!records.some((existing) => existing.costId === record.costId)) records.push(record);
      return Promise.resolve();
    },
  };
}

function spendService(storeRoot = root): SpendService {
  return new SpendService({
    store: new FileSpendReservationStore({ root: storeRoot }),
    costs: costStore(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

const ESTIMATED = { kind: "estimated", amount: { amount: "12.0000", currency: "USD" } } as const;

const reserveInput = {
  operation: "agent.execute",
  runId: RUN,
  stageId: STAGE,
  attemptId: "att-1",
  effectKey: "effect-a",
  expectation: ESTIMATED,
} as const;

/** Reserve, and fail loudly rather than silently testing a refusal. */
async function reserve(
  spend: SpendService,
  overrides: Partial<Parameters<SpendService["reserve"]>[0]> = {},
) {
  const outcome = await spend.reserve({ ...reserveInput, grant: grant(), ...overrides });
  if (!outcome.reserved) {
    throw new Error(`expected a reservation, got: ${JSON.stringify(outcome)}`);
  }
  return outcome.reservation;
}

describe("what the store establishes about a stuck stage", () => {
  it("names the safe row for a stage whose reservation was never dispatched", async () => {
    const spend = spendService();
    await reserve(spend);

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe(
      "reserved_never_dispatched",
    );
  });

  it("flips to the dispatch row the moment `prepareDispatch` is appended, and nothing else changes", async () => {
    // The whole distinction, on one reservation: `dispatch_prepared` is appended *before* the
    // provider call precisely so this window is visible rather than inferred (ADR-0044).
    const spend = spendService();
    const reservation = await reserve(spend);
    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe(
      "reserved_never_dispatched",
    );

    await spend.prepareDispatch(reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe("dispatch_possible");
  });

  it("sees a dispatched reservation that a retry left carrying the first attempt's id", async () => {
    // The reason the read is stage-scoped and not attempt-scoped, driven through the real
    // `reserve`: idempotency on `effectKey` returns the existing reservation *unchanged*, so
    // after nine retries the reservation still reads `att-1` while the stuck attempt is `att-10`.
    const spend = spendService();
    const first = await reserve(spend, { attemptId: "att-1" });
    await spend.prepareDispatch(first, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });
    const afterRetry = await reserve(spend, { attemptId: "att-10" });

    expect(afterRetry.reservationId).toBe(first.reservationId);
    expect(afterRetry.attemptId).toBe("att-1");
    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe("dispatch_possible");
  });

  it("reads every grant, not the first one holding a reservation for the Run", async () => {
    // `reserve` resolves idempotency per grant stream, so one `effectKey` can hold a reservation in
    // each of two grants. A read that stopped at one grant would report safety from half the store.
    const spend = spendService();
    await reserve(spend, { grant: grant({ grantId: "grant-a" }) });
    const second = await reserve(spend, {
      grant: grant({ grantId: "grant-b" }),
      effectKey: "effect-a",
    });
    expect(second.grantId).toBe("grant-b");
    await spend.prepareDispatch(second, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe("dispatch_possible");
  });

  it("answers per stage, so a sibling stage's dispatch does not contaminate this one", async () => {
    const spend = spendService();
    await reserve(spend);
    const sibling = await reserve(spend, { stageId: "script.write", effectKey: "effect-b" });
    await spend.prepareDispatch(sibling, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe(
      "reserved_never_dispatched",
    );
    await expect(spend.stageDispatchEvidence(RUN, "script.write")).resolves.toBe(
      "dispatch_possible",
    );
  });

  it("answers per Run, so another Run's stage of the same name does not contaminate this one", async () => {
    const spend = spendService();
    await reserve(spend);
    const otherRun = await reserve(spend, {
      grant: grant({ runId: "run-b" }),
      runId: "run-b",
      effectKey: "effect-b",
    });
    await spend.prepareDispatch(otherRun, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe(
      "reserved_never_dispatched",
    );
  });
});

describe("the answers that are not answers", () => {
  it("is indeterminate for a free stage, which reserves nothing", async () => {
    const spend = spendService();
    const outcome = await spend.reserve({
      ...reserveInput,
      grant: grant(),
      expectation: { kind: "free" },
    });
    expect(outcome).toEqual({ reserved: false, reason: "free" });

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe("indeterminate");
  });

  it("is indeterminate for a workspace that has reserved nothing", async () => {
    await expect(spendService().stageDispatchEvidence(RUN, STAGE)).resolves.toBe("indeterminate");
  });

  it("is indeterminate once the stage's reservations have all settled", async () => {
    const spend = spendService();
    const reservation = await reserve(spend);
    const prepared = await spend.prepareDispatch(reservation, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });
    await spend.settle(
      prepared,
      [
        {
          provider: "provider-a",
          operation: "agent.execute",
          billingStatus: "charged" as const,
          actual: { amount: "11.0000", currency: "USD" },
        },
      ],
      {},
    );

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).resolves.toBe("indeterminate");
  });

  it("throws rather than answering `indeterminate` for a grant it could not read", async () => {
    // The service stays honest about a failed read: what a failure to look *means* is the caller's
    // decision, and a service that answered it would put the fail-closed choice somewhere no
    // reader of the composition can see. Before the `#readCommits` fix this returned an answer.
    const spend = spendService();
    await reserve(spend);
    await mkdir(join(root, "grant-broken"), { recursive: true });
    await writeFile(join(root, "grant-broken", "commits"), "not a directory", "utf8");

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).rejects.toThrow();
  });

  it("throws for a corrupt stream with a revision gap", async () => {
    const spend = spendService();
    await reserve(spend);
    await reserve(spend, { effectKey: "effect-b" });
    await rm(join(root, "grant-agent", "commits", "000001.json"));

    await expect(spend.stageDispatchEvidence(RUN, STAGE)).rejects.toThrow(/missing revision 1/);
  });

  it("throws for a root it cannot read, rather than reporting an empty store", async () => {
    const asFile = join(root, "root-is-a-file");
    await writeFile(asFile, "not a directory", "utf8");

    await expect(spendService(asFile).stageDispatchEvidence(RUN, STAGE)).rejects.toThrow();
  });
});

describe("determinism", () => {
  it("returns one answer for five reads of an unchanged store", async () => {
    const spend = spendService();
    await reserve(spend);
    const second = await reserve(spend, { effectKey: "effect-b" });
    await spend.prepareDispatch(second, {
      backendId: "backend-a",
      backendVersion: "1.0.0",
      ceilingEnforced: false,
    });

    const answers = new Set(
      await Promise.all(Array.from({ length: 5 }, () => spend.stageDispatchEvidence(RUN, STAGE))),
    );
    expect([...answers]).toEqual(["dispatch_possible"]);
  });

  it("reads without writing: the store is unchanged and the reservation still stands", async () => {
    // A read that settled, released or otherwise touched the stream would make asking the question
    // change the answer to it.
    const spend = spendService();
    const reservation = await reserve(spend);
    await spend.stageDispatchEvidence(RUN, STAGE);

    const after = await spend.readReservation(reservation.grantId, reservation.reservationId);
    expect(after?.status).toBe("reserved");
    expect(after?.reservationId).toBe(reservation.reservationId);
  });
});
