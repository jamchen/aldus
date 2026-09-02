/**
 * A refusal that names the rule also names the way through it (#228).
 *
 * `costs`' listing was the first half and landed as `efb4c3a` under #231: it printed
 * `aldus costs abandon <reservation-id> --reason <why>` to an agent, the agent ran exactly that,
 * and `ALDUS_SPEND_NOT_AUTHORIZED` told it reconciliation is a human decision. One wasted round
 * trip, and the same one for every agent-driven adopter.
 *
 * These are the three service-side refusals that still had the shape the listing had. Each states
 * the rule correctly and stopped there, so an agent reading one had to already know — or guess —
 * that `--decided-by`/`--verbatim` is the way to record an owner's decision rather than make one.
 *
 * **What is under test is the message, never the refusal.** Every case here still asserts that the
 * call is refused; a passing suite in which one of them resolved would be the defect this change
 * must not introduce, so the refusal is asserted alongside the clause rather than replaced by it.
 *
 * The three surfaces do not share an actor, which is why they are three tests and not one
 * parameterised one:
 *
 * - `openOperatorConsole` reads the **decider** — an agent that named no `--decided-by` is its own;
 * - `reconcile`'s kind check reads the **minted authority**, a consistency check on a boundary;
 * - the `reserved` refusal reads the **transcriber**, because by that line the authority's actor is
 *   necessarily human and the party who types the next command is the one that matters.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorRef, CostRecord } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";
import type { SpendGrant } from "@aldus-runtime/gate-engine";

import type { CostRecordStore } from "../src/cost-store.js";
import { openOperatorConsole, SpendService } from "../src/spend-service.js";

const RUN = "run-a";
const AGENT: ActorRef = { kind: "agent", id: "coordinator" };
const HUMAN: ActorRef = { kind: "human", id: "operator-a" };
/**
 * The other two non-human kinds. `transcriptionRemedy`'s docstring says the rule is "non-human",
 * not "agent", and PR #267's receipt found that a mutant giving `worker` the plain form survived the
 * whole suite — every case below named `agent`, so the docstring's claim about the other kinds was a
 * description with no mechanism under it.
 */
const WORKER: ActorRef = { kind: "worker", id: "worker-a" };
const SYSTEM: ActorRef = { kind: "system", id: "scheduler-a" };
/** A second human, because the self-transcription guard compares kind *and* id. */
const OWNER: ActorRef = { kind: "human", id: "owner-a" };

const grant: SpendGrant = {
  grantId: "grant-a",
  runId: RUN,
  gateId: "agent.spend",
  decisionId: "decision-a",
  scope: { operations: ["agent.execute"] },
  maxTotal: { amount: "10.0000", currency: "USD" },
  maxPerRequest: { amount: "2.0000", currency: "USD" },
};

function costStore(): CostRecordStore & { records: CostRecord[] } {
  const records: CostRecord[] = [];
  return {
    records,
    list: () => Promise.resolve([...records]),
    append: (_runId, record) => {
      if (!records.some((entry) => entry.costId === record.costId)) records.push(record);
      return Promise.resolve();
    },
  };
}

let root: string;
let spend: SpendService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aldus-refusal-"));
  spend = new SpendService({
    store: new FileSpendReservationStore({ root }),
    costs: costStore(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A reservation whose process died between `prepareDispatch` and any billing outcome.
 *
 * `reserved`, not `billing_unknown`: nothing survived to classify it. This is the state the first
 * adopter's report was about, and the state `costs settle` refuses.
 */
async function stranded() {
  const outcome = await spend.reserve({
    grant,
    operation: "agent.execute",
    runId: RUN,
    stageId: "outline.draft",
    attemptId: "att-1",
    effectKey: "att-1:outline",
    expectation: { kind: "estimated", amount: { amount: "2.0000", currency: "USD" } },
  });
  if (!outcome.reserved) throw new Error("expected a reservation");
  return await spend.prepareDispatch(outcome.reservation, {
    backendId: "backend-a",
    backendVersion: "1.0.0",
    ceilingEnforced: false,
  });
}

describe("surface 1: opening a console for a non-human decider", () => {
  // The refusal quoted in the report, and the one an agent-driven adopter actually receives.
  // `settleSpend` and `abandonDispatch` open the console on `transcribing?.decidedBy ?? acting`,
  // so an agent that named no `--decided-by` arrives here as its own decider.
  it("tells an agent how to record a decision it may not make", () => {
    expect(() => openOperatorConsole({ spend, actor: AGENT })).toThrow(/human decision/);
    expect(() => openOperatorConsole({ spend, actor: AGENT })).toThrow(/--decided-by/);
    expect(() => openOperatorConsole({ spend, actor: AGENT })).toThrow(/--verbatim/);
  });

  it("still refuses the agent, which is the half that must not change", () => {
    // Asserted separately and deliberately. The clause is guidance appended to a refusal; a
    // console handed to an agent would be an agent able to release authorization it had itself
    // consumed (§13.3, §19.3), and no wording improvement is worth that.
    let opened = true;
    try {
      openOperatorConsole({ spend, actor: AGENT });
    } catch {
      opened = false;
    }
    expect(opened).toBe(false);
  });

  it("gives a human no clause, because there is no refusal to append it to", () => {
    // The control. A human's console opens, so the site is never reached — which is the strongest
    // form of "the human keeps the plain form".
    expect(() => openOperatorConsole({ spend, actor: HUMAN })).not.toThrow();
  });

  it("gives an unknown actor a different remedy, not this one", () => {
    // An unattributed invocation is not evidence of an agent, and its way through is to attribute
    // itself rather than to transcribe someone. Offering the transcription form here would send a
    // caller to a flag that will not help them.
    expect(() => openOperatorConsole({ spend, actor: undefined })).toThrow(/No actor identity/);
    expect(() => openOperatorConsole({ spend, actor: undefined })).not.toThrow(/--decided-by/);
  });

  describe("the rule is non-human, not agent (PR #267 receipt)", () => {
    // One case per kind rather than a parameterised loop, so a survivor names the kind it survived
    // on. Each asserts the refusal alongside the clause, for the reason the file header gives.
    it("a worker receives the clause and is refused", () => {
      expect(() => openOperatorConsole({ spend, actor: WORKER })).toThrow(/human decision/);
      expect(() => openOperatorConsole({ spend, actor: WORKER })).toThrow(/--decided-by/);
      expect(() => openOperatorConsole({ spend, actor: WORKER })).toThrow(/--verbatim/);
    });

    it("a system actor receives the clause and is refused", () => {
      expect(() => openOperatorConsole({ spend, actor: SYSTEM })).toThrow(/human decision/);
      expect(() => openOperatorConsole({ spend, actor: SYSTEM })).toThrow(/--decided-by/);
      expect(() => openOperatorConsole({ spend, actor: SYSTEM })).toThrow(/--verbatim/);
    });

    it("a human does not, and the console opens", () => {
      // Restated next to the two positives so the three kinds are read together: the human is the
      // one for whom the clause would be noise, and the only one who gets through.
      expect(() => openOperatorConsole({ spend, actor: HUMAN })).not.toThrow();
    });
  });
});

describe("surface 2: reconcile's consistency check on a minted authority", () => {
  /**
   * Reaching it takes an actor whose kind changed after the console was minted.
   *
   * Not a contrivance for coverage's sake — it is the only path there, and that is the finding.
   * `openOperatorConsole` refuses to mint a non-human authority, so this guard is defence in depth
   * against a trusted boundary contradicting itself, exactly as its docstring says. The console
   * holds the `ActorRef` it was handed by reference and builds each authority from it, so mutating
   * that object after minting is what a boundary changing its mind looks like from in here.
   */
  function consoleWhoseActorTurnedAgent(): ReturnType<typeof openOperatorConsole> {
    const drifting: ActorRef = { kind: "human", id: "operator-a" };
    const console_ = openOperatorConsole({ spend, actor: drifting });
    (drifting as { kind: string }).kind = "agent";
    return console_;
  }

  it("tells the reader of a defence-in-depth refusal how to proceed", async () => {
    const reservation = await spend.markUnknown(await stranded());
    const console_ = consoleWhoseActorTurnedAgent();

    await expect(
      console_.reconcile(reservation, {
        evidenceRef: "provider statement 2026-08, line 42",
        resolution: { kind: "investigation_ended" },
        decisionId: "d-1",
      }),
    ).rejects.toThrow(/--decided-by/);
  });

  it("still refuses it", async () => {
    const reservation = await spend.markUnknown(await stranded());
    const console_ = consoleWhoseActorTurnedAgent();

    await expect(
      console_.reconcile(reservation, {
        evidenceRef: "provider statement 2026-08, line 42",
        resolution: { kind: "investigation_ended" },
        decisionId: "d-1",
      }),
    ).rejects.toThrow(/Reconciliation is a human decision/);
  });

  it("leaves a human authority unrefused and unadorned", async () => {
    // The control, and it goes further than asserting an absent substring: the reconciliation
    // succeeds, so the guard did not fire at all.
    const reservation = await spend.markUnknown(await stranded());
    const console_ = openOperatorConsole({ spend, actor: HUMAN });

    const settled = await console_.reconcile(reservation, {
      evidenceRef: "provider statement 2026-08, line 42",
      resolution: { kind: "investigation_ended" },
      decisionId: "d-1",
    });

    expect(settled.reservation.status).toBe("billing_unknown");
  });

  // There is deliberately no unknown-actor case at this surface. An authority always carries an
  // `ActorRef`, whose `kind` the schema requires, so "no kind established" has no instance here —
  // unlike surface 1, where the actor is `ActorRef | undefined`, and surface 3, where the
  // transcription is optional. Both of those test it.
});

describe("surface 3: settling a reservation that is still reserved", () => {
  // The exact shape of #228 rather than an analogue of it: this refusal *names a command*. An
  // agent that reads it runs `aldus costs abandon` plain and is refused at surface 1 — the same
  // round trip the listing caused, one layer down.
  //
  // The console is opened on the human decider throughout, because that is what an agent using
  // `--decided-by` produces. What varies is the transcriber.
  it("names the verb and, for an agent transcriber, how to run it", async () => {
    const reservation = await stranded();
    const console_ = openOperatorConsole({ spend, actor: OWNER });

    const refusal = console_.reconcile(reservation, {
      evidenceRef: "provider statement 2026-08, line 42",
      resolution: { kind: "investigation_ended" },
      decisionId: "d-1",
      transcription: { recordedBy: AGENT, verbatim: "abandon it, it is not coming back" },
    });

    await expect(refusal).rejects.toThrow(/not terminal: it is still reserved/);
    await expect(refusal).rejects.toThrow(/aldus costs abandon/);
    await expect(refusal).rejects.toThrow(/--decided-by/);
  });

  // Same rule as surface 1, read at the transcriber rather than the decider: a worker or a system
  // process writing down an owner's decision is a non-human and needs the flag form. Two tests, not
  // a loop, so a survivor names the kind it survived on.
  it("gives a worker transcriber the clause", async () => {
    const reservation = await stranded();
    const console_ = openOperatorConsole({ spend, actor: OWNER });

    const refusal = console_.reconcile(reservation, {
      evidenceRef: "provider statement 2026-08, line 42",
      resolution: { kind: "investigation_ended" },
      decisionId: "d-1",
      transcription: { recordedBy: WORKER, verbatim: "abandon it, it is not coming back" },
    });

    await expect(refusal).rejects.toThrow(/aldus costs abandon/);
    await expect(refusal).rejects.toThrow(/--decided-by/);
  });

  it("gives a system transcriber the clause", async () => {
    const reservation = await stranded();
    const console_ = openOperatorConsole({ spend, actor: OWNER });

    const refusal = console_.reconcile(reservation, {
      evidenceRef: "provider statement 2026-08, line 42",
      resolution: { kind: "investigation_ended" },
      decisionId: "d-1",
      transcription: { recordedBy: SYSTEM, verbatim: "abandon it, it is not coming back" },
    });

    await expect(refusal).rejects.toThrow(/aldus costs abandon/);
    await expect(refusal).rejects.toThrow(/--decided-by/);
  });

  it("gives a human transcriber the plain form", async () => {
    // A human writing down another human's decision needs the verb and not the flag lesson.
    const reservation = await stranded();
    const console_ = openOperatorConsole({ spend, actor: OWNER });

    const refusal = console_.reconcile(reservation, {
      evidenceRef: "provider statement 2026-08, line 42",
      resolution: { kind: "investigation_ended" },
      decisionId: "d-1",
      transcription: { recordedBy: HUMAN, verbatim: "abandon it, it is not coming back" },
    });

    await expect(refusal).rejects.toThrow(/aldus costs abandon/);
    await expect(refusal).rejects.not.toThrow(/--decided-by/);
  });

  it("gives the plain form when nobody is transcribing", async () => {
    // The ordinary human path: no transcription at all, so no clause. This is the case that would
    // regress into noise if the clause were printed unconditionally — and a hint every human
    // learns to skip is how it stops working on the day it matters.
    const reservation = await stranded();
    const console_ = openOperatorConsole({ spend, actor: HUMAN });

    const refusal = console_.reconcile(reservation, {
      evidenceRef: "provider statement 2026-08, line 42",
      resolution: { kind: "investigation_ended" },
      decisionId: "d-1",
    });

    await expect(refusal).rejects.toThrow(/aldus costs abandon/);
    await expect(refusal).rejects.not.toThrow(/--decided-by/);
  });

  it("says nothing about transcription when the reservation is terminal", async () => {
    // The other branch of the same conditional, and the control against over-applying the fix. A
    // terminal reservation has no verb to offer, so appending a flag form to "never resumes" would
    // be advice about a command that cannot help — #228's own defect, reintroduced by its fix.
    //
    // Reached through `releaseBeforeDispatch` rather than a settlement: a settled reservation
    // carries a reconciliation decision, and the guard against overwriting one fires before the
    // state guard, so a settlement never arrives at this line.
    const outcome = await spend.reserve({
      grant,
      operation: "agent.execute",
      runId: RUN,
      stageId: "outline.draft",
      attemptId: "att-1",
      effectKey: "att-1:outline",
      expectation: { kind: "estimated", amount: { amount: "2.0000", currency: "USD" } },
    });
    if (!outcome.reserved) throw new Error("expected a reservation");
    const released = await spend.releaseBeforeDispatch(outcome.reservation, "nothing was spawned");
    expect(released.status).toBe("released");

    const refusal = openOperatorConsole({ spend, actor: OWNER }).reconcile(released, {
      evidenceRef: "provider statement 2026-08, line 42",
      resolution: { kind: "investigation_ended" },
      decisionId: "d-1",
      transcription: { recordedBy: AGENT, verbatim: "try again" },
    });

    await expect(refusal).rejects.toThrow(/never resumes/);
    await expect(refusal).rejects.not.toThrow(/--decided-by/);
  });
});
