/**
 * The bounded rework controller (ADR-0055; #220).
 *
 * Every case is a decision about durable state alone. That is the property under test as much as
 * the outcomes are: criterion 4 requires a process with no memory of the previous rounds to reach
 * the same next action, so a controller that needed anything not on disk would satisfy the
 * outcomes and fail the requirement.
 */

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type ReworkPolicy, type ReworkRound } from "@aldus-runtime/core";

import { decideRework, type ReworkVerdict } from "../src/rework.js";

const FALLBACK = "editorial.freeze";

const policy = (over: Partial<ReworkPolicy> = {}): ReworkPolicy => ({
  schemaVersion: SCHEMA_VERSION,
  policyId: "policy-a",
  stageId: "script.oracle",
  repairStageId: "script.revise",
  coversFindingClasses: ["comprehension"],
  maxRounds: 2,
  escalateToGateId: "script.freeze",
  authorizationId: "decision-a",
  ...over,
});

const round = (index: number, input: string, output: string): ReworkRound => ({
  schemaVersion: SCHEMA_VERSION,
  policyId: "policy-a",
  runId: "run-a",
  roundIndex: index,
  inputDigest: input,
  consumedFindingClasses: ["comprehension"],
  repairStageId: "script.revise",
  repairAttemptId: `att-${index}`,
  outputDigest: output,
  costIds: [],
  actor: { kind: "agent", id: "agent-a" },
  at: "2026-08-27T00:00:00.000Z",
});

const verdict = (over: Partial<ReworkVerdict> = {}): ReworkVerdict => ({
  artifactDigest: "a".repeat(64),
  blockingFindingClasses: ["comprehension"],
  ...over,
});

describe("a covered blocking finding reworks without a human decision", () => {
  it("runs the declared repair and numbers the round", () => {
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      verdict: verdict(),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("rework");
    if (decision.kind !== "rework") return;
    expect(decision.round).toBe(1);
    expect(decision.repairStageId).toBe("script.revise");
    expect(decision.consumeFindingClasses).toEqual(["comprehension"]);
  });

  it("numbers the next round from the history, not from a counter it holds", () => {
    // Criterion 4. A process that restarted between rounds has only the records; if the round
    // number came from anywhere else, the resumed process would repeat or skip one.
    const decision = decideRework({
      policy: policy({ maxRounds: 5 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64)), round(2, "b".repeat(64), "c".repeat(64))],
      verdict: verdict({ artifactDigest: "c".repeat(64) }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("rework");
    if (decision.kind !== "rework") return;
    expect(decision.round).toBe(3);
  });
});

describe("a clean verdict releases the next stage", () => {
  it("converges when nothing blocks", () => {
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      verdict: verdict({ blockingFindingClasses: [] }),
      fallbackGateId: FALLBACK,
    });

    expect(decision).toEqual({ kind: "converged", artifactDigest: "a".repeat(64) });
  });

  it("converges even with the bound spent, because a passing artifact is passing", () => {
    // Order matters: checking exhaustion first would escalate an artifact that already converged,
    // which is the one outcome that turns a safety bound into a source of manual work.
    const decision = decideRework({
      policy: policy({ maxRounds: 1 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64))],
      verdict: verdict({ artifactDigest: "b".repeat(64), blockingFindingClasses: [] }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("converged");
  });

  it("treats advisory-only findings as clean, because they were declared not to block", () => {
    // `blockingFindingClasses` carries what the stage's declared enforcement classified as
    // blocking (§12.1). Advisory findings are recorded and absent from it — the controller never
    // sees them, which is what stops it reclassifying a finding the stage already judged.
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      verdict: verdict({ blockingFindingClasses: [] }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("converged");
  });
});

describe("every automatic exit lands on a named gate", () => {
  it("escalates when the bound is spent", () => {
    const decision = decideRework({
      policy: policy({ maxRounds: 2 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64)), round(2, "b".repeat(64), "c".repeat(64))],
      verdict: verdict({ artifactDigest: "c".repeat(64) }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("bounds_exhausted");
    expect(decision.gateId).toBe("script.freeze");
    // The bound itself, so an operator does not have to go looking for what was authorised.
    expect(decision.explanation).toContain("2");
  });

  it("escalates on oscillation, which no single round can see", () => {
    // A -> B -> A. Both rounds look like progress; the loop will never converge. This is the only
    // stop reason invisible to a controller reading the latest verdict alone, and the reason the
    // durable state is the history.
    const decision = decideRework({
      policy: policy({ maxRounds: 9 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64)), round(2, "b".repeat(64), "a".repeat(64))],
      verdict: verdict({ artifactDigest: "a".repeat(64) }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("oscillation");
  });

  it("does not call the very first evaluation an oscillation", () => {
    // The negative control for the case above. Round 1's input digest is the artifact under
    // evaluation, and a check that compared against inputs rather than outputs would escalate
    // every loop on its second look — passing the oscillation test and breaking every real one.
    const decision = decideRework({
      policy: policy({ maxRounds: 9 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64))],
      verdict: verdict({ artifactDigest: "b".repeat(64) }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("rework");
  });

  it("escalates a blocking class the policy does not cover", () => {
    const decision = decideRework({
      policy: policy({ coversFindingClasses: ["comprehension"] }),
      rounds: [],
      verdict: verdict({ blockingFindingClasses: ["comprehension", "legal"] }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("unknown_finding_class");
    expect(decision.explanation).toContain("legal");
  });

  it("escalates an ambiguous verdict rather than reading it either way", () => {
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      verdict: verdict({ blockingFindingClasses: [], ambiguous: true }),
      fallbackGateId: FALLBACK,
    });

    // Note the verdict carries no blocking classes: read as clean it would have converged. An
    // unreadable result is not evidence of passing, and that is the direction the mistake goes.
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("ambiguous_verdict");
  });

  it("escalates when no policy covers the stage", () => {
    const decision = decideRework({ rounds: [], verdict: verdict(), fallbackGateId: FALLBACK });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("no_policy");
    // The caller's gate, because a gate id Core invented would be one no registry holds — a
    // permanent silent stop that looks like the loop halted safely (#221).
    expect(decision.gateId).toBe(FALLBACK);
  });
});

describe("the decision is a function of durable state alone", () => {
  it("reaches the same decision from the same records, twice", () => {
    // Criterion 4 stated as a test rather than as a comment. Two calls stand in for two processes;
    // what makes it meaningful is that the input is exactly what a restarted process could read.
    const input = {
      policy: policy({ maxRounds: 3 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64))],
      verdict: verdict({ artifactDigest: "b".repeat(64) }),
      fallbackGateId: FALLBACK,
    };

    expect(decideRework(input)).toEqual(decideRework(input));
  });
});
