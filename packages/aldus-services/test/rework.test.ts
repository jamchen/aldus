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

import { decideRework, type EvaluatedVerdict } from "../src/rework.js";

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
  automaticCorrectionHarm:
    "A wrong repair rewrites narration the host will read aloud; bounded at two rounds and " +
    "escalated to the editorial freeze, so no unreviewed rewrite reaches a take.",
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

const verdict = (over: Partial<EvaluatedVerdict> = {}): EvaluatedVerdict => ({
  kind: "evaluated",
  artifactDigest: "a".repeat(64),
  blockingFindingClasses: ["comprehension"],
  observedFindingClasses: over.blockingFindingClasses ?? ["comprehension"],
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

describe("an advisory finding a policy covers still warrants repair (ADR-0056)", () => {
  // Reported by the first adopter compiling against next.40. Their oracle emits eight finding
  // classes and all eight channels are `advisory`, because §12.1 permits a blocking channel only
  // after calibration and none of the eight has promotion evidence. So `blockingFindingClasses` is
  // correctly `[]` on every attempt.
  //
  // Under ADR-0055 the controller read only that list, so for a model-assisted evaluator the
  // derived verdict was always `pass` — the loop was unreachable for exactly the population that
  // needs one, and an adopter got it only by declaring their own policy beside the runtime's and
  // hoping the two agreed.
  it("reworks on a covered advisory class with nothing blocking", () => {
    const decision = decideRework({
      policy: policy({ coversFindingClasses: ["unresolved_reference", "time_anchor_missing"] }),
      rounds: [],
      verdict: verdict({
        blockingFindingClasses: [],
        observedFindingClasses: ["unresolved_reference", "cut_candidate"],
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("rework");
    if (decision.kind !== "rework") return;
    // Only the covered class. Handing the repair `cut_candidate` would be acting on a class the
    // policy's authorisation never named.
    expect(decision.consumeFindingClasses).toEqual(["unresolved_reference"]);
  });

  it("converges when the only advisory classes are ones no policy covers", () => {
    // The control, and the reason this is not "rework on anything observed": an advisory finding
    // outside the policy is one the adopter chose to record and not act on. That is what advisory
    // means, and reworking it would make every recorded observation compulsory.
    const decision = decideRework({
      policy: policy({ coversFindingClasses: ["unresolved_reference"] }),
      rounds: [],
      verdict: verdict({
        blockingFindingClasses: [],
        observedFindingClasses: ["cut_candidate", "style_note"],
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("converged");
  });

  it("still escalates a blocking class the policy does not cover", () => {
    // The invariant that must survive the widening: rework never releases what enforcement blocked.
    const decision = decideRework({
      policy: policy({ coversFindingClasses: ["comprehension"] }),
      rounds: [],
      verdict: verdict({
        blockingFindingClasses: ["legal"],
        observedFindingClasses: ["legal", "comprehension"],
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("unknown_finding_class");
  });

  it("is still bounded when the trigger is advisory", () => {
    // An uncalibrated evaluator driving an unbounded loop is the thing §12.1 exists to prevent.
    // The bound is what makes the widening safe, so it is asserted on this path specifically.
    const decision = decideRework({
      policy: policy({ coversFindingClasses: ["unresolved_reference"], maxRounds: 1 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64))],
      verdict: verdict({
        artifactDigest: "b".repeat(64),
        blockingFindingClasses: [],
        observedFindingClasses: ["unresolved_reference"],
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("bounds_exhausted");
  });

  it("does not escalate an advisory class outside the policy as unknown", () => {
    // `unknown_finding_class` means "enforcement stopped work and no bounded round can resolve it".
    // Firing it for an advisory class would send a person a decision nobody needs to make, and the
    // hint an operator learns to skip is the one that fails on the day it matters.
    const decision = decideRework({
      policy: policy({ coversFindingClasses: ["unresolved_reference"] }),
      rounds: [],
      verdict: verdict({
        blockingFindingClasses: [],
        observedFindingClasses: ["unresolved_reference", "style_note"],
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("rework");
  });
});

describe("a loop that is measurably getting worse stops (#220)", () => {
  // Reported by the first adopter from a real run, while writing the `automaticCorrectionHarm` the
  // policy now requires: a repair round took their script from 4 findings to 7 **by adding
  // explanation**, and narration grew 2,246 → 2,551 → 2,904 characters over three rounds. A
  // comprehension evaluator reads a longer script with more connective tissue as an improvement, so
  // the loop can make a commentary script worse while every number it watches says better.
  //
  // Oscillation cannot see this: every round produced a different artifact, so every digest is new.
  const worsening = (before: number, now: number) => ({
    policy: policy({ maxRounds: 5, coversFindingClasses: ["comprehension"] }),
    rounds: [{ ...round(1, "a".repeat(64), "b".repeat(64)), inputFindingCount: before }],
    verdict: verdict({
      artifactDigest: "b".repeat(64),
      blockingFindingClasses: [],
      observedFindingClasses: ["comprehension"],
      findingCount: now,
    }),
    fallbackGateId: FALLBACK,
  });

  it("escalates when the repair increased the finding count", () => {
    const decision = decideRework(worsening(4, 7));

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("regression");
    // Both numbers, so an operator reads what happened rather than a state name.
    expect(decision.explanation).toContain("4");
    expect(decision.explanation).toContain("7");
  });

  it("keeps working when the repair reduced the count", () => {
    // The positive control. Without it the case above passes for an arm that escalates every second
    // round, which would break every healthy loop and look like caution.
    expect(decideRework(worsening(7, 4)).kind).toBe("rework");
  });

  it("keeps working when the count is unchanged", () => {
    // Equal is not progress, and it is deliberately not a stop. A repair that resolves a deep
    // problem and exposes one shallower one nets zero, and escalating that would hand a person a
    // decision the bound already covers. Increase is the unambiguous signal; the bound catches the
    // rest.
    expect(decideRework(worsening(4, 4)).kind).toBe("rework");
  });

  it("stays silent when either count is missing, rather than reading absence as progress", () => {
    // A round recorded before the field, or an evaluator whose evidence is reports rather than
    // enumerated findings, has no count to compare. Inferring one is the move
    // `defectCountMeasurable` exists to prevent (#140), so the arm does not fire — a hole, not a
    // clean bill.
    const input = worsening(4, 7);
    const rounds = [{ ...input.rounds[0]!, inputFindingCount: undefined }];
    expect(decideRework({ ...input, rounds }).kind).toBe("rework");

    const { findingCount: _dropped, ...verdictWithoutCount } = input.verdict;
    expect(decideRework({ ...input, verdict: verdictWithoutCount }).kind).toBe("rework");
  });

  it("does not fire on the first evaluation, which has no previous round", () => {
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      verdict: verdict({ findingCount: 99 }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("rework");
  });

  it("reports regression rather than exhaustion when both are true", () => {
    // Both escalate to the same gate, so this is about what the person is told. "The bound is
    // spent" invites raising the bound; "the repair made it worse" is the fact that makes raising
    // it the wrong move. The more actionable reason wins, and the ordering is what makes that so.
    const decision = decideRework({
      policy: policy({ maxRounds: 1 }),
      rounds: [{ ...round(1, "a".repeat(64), "b".repeat(64)), inputFindingCount: 4 }],
      verdict: verdict({
        artifactDigest: "b".repeat(64),
        blockingFindingClasses: [],
        observedFindingClasses: ["comprehension"],
        findingCount: 7,
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("regression");
  });

  it("still converges on a clean verdict even after a worsening round", () => {
    // Order matters here as it does for exhaustion: an artifact that now passes must not be
    // escalated for how it got there.
    const decision = decideRework({
      policy: policy({ maxRounds: 5 }),
      rounds: [{ ...round(1, "a".repeat(64), "b".repeat(64)), inputFindingCount: 4 }],
      verdict: verdict({
        artifactDigest: "b".repeat(64),
        blockingFindingClasses: [],
        observedFindingClasses: [],
        findingCount: 7,
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("converged");
  });
});

describe("an evaluation that did not happen is not a clean one (#220)", () => {
  // Reported by the first adopter after measuring rather than recalling: their oracle skipped its
  // output contract four times in forty, delivering prose with no fenced block. The analysis was
  // real and the structure was missing.
  //
  // The previous shape had one verdict type whose empty state meant "the evaluator ran and found
  // nothing". An attempt with no evaluation produces the same empty state, so a caller reading
  // `enumeratedFindings: 0` off a record got `converged` — a non-answer read as a pass, in the arm
  // that releases the next stage.
  it("escalates rather than converging", () => {
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      verdict: {
        kind: "not_evaluated",
        artifactDigest: "a".repeat(64),
        reason: "the stage produced no fenced oracle block",
      },
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("no_evaluation");
    // The caller's own words, so an operator reads what went wrong rather than a state name.
    expect(decision.explanation).toContain("no fenced oracle block");
  });

  it("escalates with no policy too, to the caller's gate", () => {
    // A missing evaluation is not a policy question. Reaching the `no_policy` arm first would tell
    // an operator to declare a policy when what is missing is the evaluation.
    const decision = decideRework({
      rounds: [],
      verdict: { kind: "not_evaluated", artifactDigest: "a".repeat(64), reason: "stage failed" },
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("no_evaluation");
    expect(decision.gateId).toBe(FALLBACK);
  });

  it("still converges for an evaluation that ran and found nothing", () => {
    // The control, and the distinction the split exists to make. These two produce identical
    // finding lists; only the caller's assertion that an evaluation happened tells them apart.
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      verdict: verdict({ blockingFindingClasses: [], observedFindingClasses: [] }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("converged");
  });
});

describe("an escalation hands over every candidate it produced (#220)", () => {
  // The first adopter's owner bought an extra round and the round made the script worse:
  // `7 → 7 → 2 → 5` findings, narration 2,887 → 3,063 characters. The loop always carries the
  // newest candidate forward, so what reaches the gate is the worst artifact of the four, and the
  // useful one — the round that measured 2 — is reachable only by whoever goes looking.
  //
  // Reported, never ranked. Ordering by count would recommend exactly the artifact their
  // `automaticCorrectionHarm` warns about: a repair that cuts a load-bearing clause produces fewer
  // findings and a worse script. Fewer findings is not better; it is fewer findings.
  const history = [
    { ...round(1, "a".repeat(64), "b".repeat(64)), inputFindingCount: 7 },
    { ...round(2, "b".repeat(64), "c".repeat(64)), inputFindingCount: 2 },
  ];

  it("lists every artifact the loop saw, oldest first, with the latest last", () => {
    const decision = decideRework({
      policy: policy({ maxRounds: 2 }),
      rounds: history,
      verdict: verdict({
        artifactDigest: "c".repeat(64),
        blockingFindingClasses: ["comprehension"],
        observedFindingClasses: ["comprehension"],
        findingCount: 5,
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.candidates).toEqual([
      { digest: "a".repeat(64), findingCount: 7 },
      { digest: "b".repeat(64), findingCount: 2 },
      { digest: "c".repeat(64), findingCount: 5 },
    ]);
    // The one it stopped on is the newest, and it is not the best. Both facts are on the decision.
    expect(decision.artifactDigest).toBe("c".repeat(64));
  });

  it("does not reorder them, so nothing reads as a recommendation", () => {
    // The assertion that keeps Core out of the editorial judgement. A sorted list is a ranking
    // whatever the docstring says, and a reader would take the first entry as the advice.
    const decision = decideRework({
      policy: policy({ maxRounds: 2 }),
      rounds: history,
      verdict: verdict({
        artifactDigest: "c".repeat(64),
        blockingFindingClasses: ["comprehension"],
        observedFindingClasses: ["comprehension"],
        findingCount: 5,
      }),
      fallbackGateId: FALLBACK,
    });

    if (decision.kind !== "escalate") throw new Error("expected an escalation");
    const counts = decision.candidates.map((entry) => entry.findingCount);
    expect(counts).not.toEqual([...counts].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it("omits a count that was never measured rather than writing zero", () => {
    // A hole, not a zero. A count over report-shaped evidence is not a smaller number (#140), and
    // a `0` here would make an unmeasured artifact look like the best one in the list.
    const decision = decideRework({
      policy: policy({ maxRounds: 1 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64))],
      verdict: verdict({
        artifactDigest: "b".repeat(64),
        blockingFindingClasses: ["comprehension"],
        observedFindingClasses: ["comprehension"],
      }),
      fallbackGateId: FALLBACK,
    });

    if (decision.kind !== "escalate") throw new Error("expected an escalation");
    expect(decision.candidates).toEqual([{ digest: "a".repeat(64) }, { digest: "b".repeat(64) }]);
  });

  it("carries them on an escalation that never ran a round", () => {
    // `no_policy` and `no_evaluation` fire with an empty history, and the artifact under judgement
    // is still a candidate. An empty list here would make the gate's subject unreachable from the
    // decision that escalated to it.
    const decision = decideRework({
      rounds: [],
      verdict: { kind: "not_evaluated", artifactDigest: "a".repeat(64), reason: "stage failed" },
      fallbackGateId: FALLBACK,
    });

    if (decision.kind !== "escalate") throw new Error("expected an escalation");
    expect(decision.candidates).toEqual([{ digest: "a".repeat(64) }]);
  });
});
