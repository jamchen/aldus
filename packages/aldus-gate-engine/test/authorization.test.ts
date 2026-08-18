/**
 * What must be impossible (architecture contract §13.2, §19.3).
 *
 * Contract §13.2: "Paid TTS MUST NOT run until the operator approves ... The authorization MUST
 * be invalidated if any bound value changes." §24 restates it as a condition of V1 being done:
 * "paid TTS cannot execute without valid hash-bound authorization."
 *
 * Every test here spends real money if it fails in production. They are written to reproduce the
 * unsafe sequence — approve, then change something, then try to spend — rather than to assert
 * that a validator was called, because the sequence is the failure.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { GateEngine } from "../src/engine.js";
import { GateRegistry } from "../src/definition.js";
import { GateEngineErrorCodes } from "../src/errors.js";
import { MemoryGateDecisionStore, MemoryGateEventSink } from "../src/ports.js";
import { SPEND_LIMIT_SUBJECT_KEY, grantLimitsDigest } from "../src/spend.js";
import {
  AGENT,
  AT,
  CONTENT_FREEZE,
  EPISODE_ID,
  OPERATOR,
  PERFORMANCE_FREEZE,
  RUN_ID,
  cost,
  grantFor,
  money,
  standardGates,
  standardSubjects,
} from "./helpers.js";

let engine: GateEngine;
let decisions: MemoryGateDecisionStore;
let events: MemoryGateEventSink;

beforeEach(() => {
  decisions = new MemoryGateDecisionStore();
  events = new MemoryGateEventSink();
  engine = new GateEngine({
    registry: GateRegistry.from(standardGates()),
    decisions,
    events,
  });
});

/** Approve the content freeze and the performance freeze, binding a real spend grant. */
async function approveThroughPerformance(maxTotal = "10.00", maxPerRequest?: string) {
  const grant = grantFor("dec-performance", maxTotal, maxPerRequest);
  const subjects = standardSubjects({}, grant);

  await engine.decide({
    runId: RUN_ID,
    gateId: CONTENT_FREEZE,
    decision: "approved",
    subjects: subjects[CONTENT_FREEZE] ?? [],
    decidedBy: OPERATOR,
    decidedAt: AT,
    episodeId: EPISODE_ID,
    decisionId: "dec-content",
    eventId: "evt-content",
  });
  await engine.decide({
    runId: RUN_ID,
    gateId: PERFORMANCE_FREEZE,
    decision: "approved",
    subjects: subjects[PERFORMANCE_FREEZE] ?? [],
    decidedBy: OPERATOR,
    decidedAt: AT,
    episodeId: EPISODE_ID,
    decisionId: "dec-performance",
    eventId: "evt-performance",
  });

  return { grant, subjects };
}

describe("paid work requires a valid authorization (§13.2)", () => {
  it("refuses spend when nobody has approved anything", async () => {
    const grant = grantFor("dec-performance", "10.00");
    const result = await engine.authorizeSpend(
      RUN_ID,
      grant,
      { amount: money("1.00") },
      standardSubjects({}, grant),
    );

    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    // Blocked by the upstream Content Freeze rather than merely pending on its own: with nothing
    // approved anywhere, §13.1's cascade reaches the paid gate before its own state matters.
    expect(result.explanation).toContain("blocked_upstream");
  });

  it("allows spend within an approved ceiling", async () => {
    const { grant, subjects } = await approveThroughPerformance("10.00");
    const result = await engine.authorizeSpend(RUN_ID, grant, { amount: money("4.00") }, subjects);

    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(result.check.remainingAfter).toEqual(money("6.00"));
  });

  // The core §13.2 requirement. Each of these changes one bound value after approval and proves
  // the authorization no longer holds.
  it.each([
    ["the spoken text", "spokenText"],
    ["the performance script", "performanceScript"],
    ["the voice settings", "voiceSettings"],
    ["the request plan", "requestPlan"],
  ])("refuses spend after %s changes", async (_label, changedKey) => {
    const { grant } = await approveThroughPerformance("10.00");

    // The edit. Everything else is untouched.
    const afterEdit = standardSubjects({ [changedKey]: `${changedKey}-v2` }, grant);
    const result = await engine.authorizeSpend(RUN_ID, grant, { amount: money("1.00") }, afterEdit);

    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.explanation).toMatch(/stale|blocked_upstream/);
  });

  it("names which bound value moved, so an operator knows what to re-approve", async () => {
    const { grant } = await approveThroughPerformance("10.00");
    const statuses = await engine.evaluate(
      RUN_ID,
      standardSubjects({ voiceSettings: "voiceSettings-v2" }, grant),
    );

    const status = statuses.get(PERFORMANCE_FREEZE);
    expect(status?.state).toBe("stale");
    expect(status?.drift?.changed).toEqual(["voiceSettings"]);
  });
});

describe("the spend ceiling cannot be raised without re-approval (§13.2)", () => {
  it("refuses a grant whose limits were never bound by the decision", async () => {
    // The caller bound `spendLimit` to some ordinary value instead of the grant's digest — the
    // shape of mistake where an approval looks complete but never actually covered a ceiling.
    // Nothing drifts here: the subjects match the decision exactly. The gate is satisfied, and
    // the refusal comes from the grant digest being absent from what was approved.
    const unboundSubjects = standardSubjects();
    await engine.decide({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE,
      decision: "approved",
      subjects: unboundSubjects[CONTENT_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-content",
    });
    await engine.decide({
      runId: RUN_ID,
      gateId: PERFORMANCE_FREEZE,
      decision: "approved",
      subjects: unboundSubjects[PERFORMANCE_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-performance",
    });

    const statuses = await engine.evaluate(RUN_ID, unboundSubjects);
    expect(statuses.get(PERFORMANCE_FREEZE)?.state).toBe("satisfied");

    const result = await engine.authorizeSpend(
      RUN_ID,
      grantFor("dec-performance", "10.00"),
      { amount: money("1.00") },
      unboundSubjects,
    );

    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.explanation).toContain("maximum authorized cost");
  });

  it("refuses a grant whose ceiling was raised after approval", async () => {
    const { grant } = await approveThroughPerformance("10.00");

    // Same decision, same everything — but the operator's approved ceiling has been edited
    // upward in the grant. The subjects still carry the *original* digest, so the swap shows.
    const raised = { ...grant, maxTotal: money("1000.00") };
    const result = await engine.authorizeSpend(
      RUN_ID,
      raised,
      { amount: money("500.00") },
      standardSubjects({}, grant),
    );

    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.explanation).toContain("not");
  });

  it("binds the raised ceiling only once the operator approves it again", async () => {
    await approveThroughPerformance("10.00");
    const raised = grantFor("dec-performance-2", "1000.00");

    await engine.decide({
      runId: RUN_ID,
      gateId: PERFORMANCE_FREEZE,
      decision: "approved",
      subjects: standardSubjects({}, raised)[PERFORMANCE_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-performance-2",
      eventId: "evt-performance-2",
    });

    const result = await engine.authorizeSpend(
      RUN_ID,
      raised,
      { amount: money("500.00") },
      standardSubjects({}, raised),
    );
    expect(result.authorized).toBe(true);
  });

  it("refuses a grant citing a decision that has been superseded", async () => {
    const { grant } = await approveThroughPerformance("10.00");
    const replacement = grantFor("dec-performance-2", "10.00");

    await engine.decide({
      runId: RUN_ID,
      gateId: PERFORMANCE_FREEZE,
      decision: "approved",
      subjects: standardSubjects({}, replacement)[PERFORMANCE_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-performance-2",
      eventId: "evt-performance-2",
    });

    // The old grant names the old decision. Even though a valid approval exists, this one is not it.
    const result = await engine.authorizeSpend(
      RUN_ID,
      grant,
      { amount: money("1.00") },
      standardSubjects({}, replacement),
    );
    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.explanation).toContain("superseded");
  });
});

describe("stop-on-budget (§19.3)", () => {
  it("refuses a request that would exceed the remaining budget", async () => {
    const { grant, subjects } = await approveThroughPerformance("10.00");
    const spent = [cost("cost-1", "dec-performance", { actual: "9.50" })];

    const result = await engine.authorizeSpend(
      RUN_ID,
      grant,
      { amount: money("1.00") },
      subjects,
      spent,
    );
    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.check?.allowed).toBe(false);
    if (result.check?.allowed !== false) return;
    expect(result.check.reason).toBe("total-limit");
  });

  it("allows a request that exactly exhausts the budget", async () => {
    const { grant, subjects } = await approveThroughPerformance("10.00");
    const spent = [cost("cost-1", "dec-performance", { actual: "9.50" })];

    const result = await engine.authorizeSpend(
      RUN_ID,
      grant,
      { amount: money("0.50") },
      subjects,
      spent,
    );
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(result.check.remainingAfter).toEqual(money("0.00"));
  });

  it("enforces the per-request limit independently of the total", async () => {
    const { grant, subjects } = await approveThroughPerformance("100.00", "5.00");
    const result = await engine.authorizeSpend(
      RUN_ID,
      grant,
      { amount: money("5.01") },
      subjects,
      [],
    );

    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    if (result.check?.allowed !== false) return;
    expect(result.check.reason).toBe("per-request-limit");
  });

  it("counts a cost whose billing status is unknown (§19.3)", async () => {
    // §19.3 requires "safe handling of unknown provider billing status". Treating an
    // unconfirmed charge as free is how a run spends past its ceiling while the ledger looks clean.
    const { grant, subjects } = await approveThroughPerformance("10.00");
    const spent = [cost("cost-1", "dec-performance", { estimated: "9.90" }, "unknown")];

    const result = await engine.authorizeSpend(
      RUN_ID,
      grant,
      { amount: money("1.00") },
      subjects,
      spent,
    );
    expect(result.authorized).toBe(false);
  });

  it("does not count a voided cost", async () => {
    const { grant, subjects } = await approveThroughPerformance("10.00");
    const spent = [cost("cost-1", "dec-performance", { actual: "9.90" }, "voided")];

    const result = await engine.authorizeSpend(
      RUN_ID,
      grant,
      { amount: money("1.00") },
      subjects,
      spent,
    );
    expect(result.authorized).toBe(true);
  });

  it("ignores costs drawn against a different authorization", async () => {
    const { grant, subjects } = await approveThroughPerformance("10.00");
    const spent = [cost("cost-1", "some-other-decision", { actual: "9.90" })];

    const result = await engine.authorizeSpend(
      RUN_ID,
      grant,
      { amount: money("1.00") },
      subjects,
      spent,
    );
    expect(result.authorized).toBe(true);
  });
});

describe("a decision requires a permitted actor (§19.2, §13.3)", () => {
  it("refuses a human-oracle gate decided by an agent", async () => {
    const subjects = standardSubjects();
    await expect(
      engine.decide({
        runId: RUN_ID,
        gateId: CONTENT_FREEZE,
        decision: "approved",
        subjects: subjects[CONTENT_FREEZE] ?? [],
        decidedBy: AGENT,
        decidedAt: AT,
        episodeId: EPISODE_ID,
      }),
    ).rejects.toMatchObject({ code: GateEngineErrorCodes.GATE_ACTOR_NOT_PERMITTED });
  });

  it("records the deciding actor on every decision", async () => {
    await approveThroughPerformance();
    const stored = await decisions.list(RUN_ID);
    expect(stored).toHaveLength(2);
    for (const decision of stored) {
      expect(decision.decidedBy).toEqual(OPERATOR);
    }
  });

  it("refuses a decision that does not bind everything the gate requires", async () => {
    const subjects = standardSubjects();
    const partial = (subjects[PERFORMANCE_FREEZE] ?? []).slice(0, 2);

    await expect(
      engine.decide({
        runId: RUN_ID,
        gateId: PERFORMANCE_FREEZE,
        decision: "approved",
        subjects: partial,
        decidedBy: OPERATOR,
        decidedAt: AT,
        episodeId: EPISODE_ID,
      }),
    ).rejects.toMatchObject({ code: GateEngineErrorCodes.GATE_SUBJECTS_INCOMPLETE });
  });

  it("emits an event for every decision (§6.4)", async () => {
    await approveThroughPerformance();
    expect(events.events).toHaveLength(2);
    expect(events.events[0]).toMatchObject({
      action: "gate.approved",
      runId: RUN_ID,
      episodeId: EPISODE_ID,
    });
    expect(events.events[0]?.details).toMatchObject({ gateId: CONTENT_FREEZE });
  });
});

describe("the spend limit subject key", () => {
  it("binds the grant's limits, not its identity", () => {
    const a = grantFor("dec-1", "10.00");
    const b = { ...a, grantId: "grant-b" };
    // Re-issuing the same ceiling must not read as the operator approving something different.
    expect(grantLimitsDigest(a)).toBe(grantLimitsDigest(b));
    expect(SPEND_LIMIT_SUBJECT_KEY).toBe("spendLimit");
  });

  it("changes when either limit changes", () => {
    const base = grantFor("dec-1", "10.00");
    expect(grantLimitsDigest({ ...base, maxTotal: money("10.01") })).not.toBe(
      grantLimitsDigest(base),
    );
    expect(grantLimitsDigest({ ...base, maxPerRequest: money("1.00") })).not.toBe(
      grantLimitsDigest(base),
    );
  });
});
