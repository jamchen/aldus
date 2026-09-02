/**
 * The bounded rework controller (ADR-0055; #220).
 *
 * Every case is a decision about durable state alone. That is the property under test as much as
 * the outcomes are: criterion 4 requires a process with no memory of the previous rounds to reach
 * the same next action, so a controller that needed anything not on disk would satisfy the
 * outcomes and fail the requirement.
 */

import { describe, expect, it } from "vitest";

import {
  AldusError,
  SCHEMA_VERSION,
  type ReworkPolicy,
  type ReworkRound,
} from "@aldus-runtime/core";

import {
  decideRework,
  type EvaluatedVerdict,
  type ReworkDecision,
  type ReworkInput,
  type RunningAttemptVerdict,
} from "../src/rework.js";

const FALLBACK = "editorial.freeze";

const policy = (over: Partial<ReworkPolicy> = {}): ReworkPolicy => ({
  schemaVersion: SCHEMA_VERSION,
  policyId: "policy-a",
  stageId: "script.oracle",
  repairStageId: "script.revise",
  coversFindingClasses: ["comprehension"],
  maxRounds: 2,
  escalateToGateId: "script.freeze",
  candidateArtifactKind: "script-candidate",
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

describe("an approval at the gate clears the stop it answers (#220)", () => {
  // Named by the first adopter: "a gate that lets a person overrule a stop cannot overrule one of
  // five causes and not the rest." They raised their bound after an escalation and the loop still
  // stopped — on a fact about the history, while the person was answering a question about the next
  // round. A gate that appears to release the loop and does not is worse than one that never
  // offered.
  const stuck = (over: Partial<Parameters<typeof decideRework>[0]> = {}) => ({
    policy: policy({ maxRounds: 1 }),
    rounds: [{ ...round(1, "a".repeat(64), "b".repeat(64)), inputFindingCount: 4 }],
    verdict: verdict({
      artifactDigest: "b".repeat(64),
      blockingFindingClasses: [],
      observedFindingClasses: ["comprehension"],
      findingCount: 7,
    }),
    fallbackGateId: FALLBACK,
    ...over,
  });

  it("clears a regression", () => {
    const first = decideRework(stuck());
    expect(first.kind === "escalate" ? first.reason : "").toBe("regression");
    expect(decideRework(stuck({ approvedContinuationDigests: ["b".repeat(64)] })).kind).toBe(
      "rework",
    );
  });

  it("clears an exhausted bound", () => {
    const base = stuck({
      verdict: verdict({
        artifactDigest: "b".repeat(64),
        blockingFindingClasses: [],
        observedFindingClasses: ["comprehension"],
      }),
    });
    const before = decideRework(base);
    expect(before.kind === "escalate" ? before.reason : "").toBe("bounds_exhausted");
    expect(decideRework({ ...base, approvedContinuationDigests: ["b".repeat(64)] }).kind).toBe(
      "rework",
    );
  });

  it("clears an oscillation", () => {
    const base = {
      policy: policy({ maxRounds: 9 }),
      rounds: [round(1, "a".repeat(64), "b".repeat(64)), round(2, "b".repeat(64), "a".repeat(64))],
      verdict: verdict({ artifactDigest: "a".repeat(64) }),
      fallbackGateId: FALLBACK,
    };
    const before = decideRework(base);
    expect(before.kind === "escalate" ? before.reason : "").toBe("oscillation");
    expect(decideRework({ ...base, approvedContinuationDigests: ["a".repeat(64)] }).kind).toBe(
      "rework",
    );
  });

  it("applies only to the artifact it was given for", () => {
    // The reason this takes digests rather than a count. An approval is a decision about what the
    // person was shown; a count would suppress a stop three rounds later that nobody had seen, and
    // §13 already binds a decision to its subjects.
    const other = decideRework(stuck({ approvedContinuationDigests: ["c".repeat(64)] }));
    expect(other.kind === "escalate" ? other.reason : "").toBe("regression");
  });

  it("does not clear a missing evaluation, which no approval can supply", () => {
    // The line is meaningful versus impossible, not mild versus severe. An approval authorises more
    // work; it cannot supply an evaluation that was never recorded.
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      approvedContinuationDigests: ["a".repeat(64)],
      verdict: { kind: "not_evaluated", artifactDigest: "a".repeat(64), reason: "no block" },
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("no_evaluation");
  });

  it("does not clear a finding class the policy never covered", () => {
    // A repair has no instruction for it. Clearing this would hand the loop an authorisation it
    // cannot act on.
    const decision = decideRework({
      policy: policy({ coversFindingClasses: ["comprehension"] }),
      rounds: [],
      approvedContinuationDigests: ["a".repeat(64)],
      verdict: verdict({
        blockingFindingClasses: ["legal"],
        observedFindingClasses: ["legal"],
      }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("unknown_finding_class");
  });

  it("does not turn a clean verdict into a round", () => {
    // An approval buys a repair, not a repair of something that passed. Convergence is checked
    // before any of this and must stay that way.
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      approvedContinuationDigests: ["a".repeat(64)],
      verdict: verdict({ blockingFindingClasses: [], observedFindingClasses: [] }),
      fallbackGateId: FALLBACK,
    });

    expect(decision.kind).toBe("converged");
  });
});

/**
 * The fourth state: an attempt durably recorded as `running` (#220, ADR-0057).
 *
 * Named by the first adopter after a harness timeout killed a dispatch. Their record showed
 * `status: "running"`, attempt 10, no cost record — and their own observation is what makes it a
 * category: a different kill one second later would show a charge and an artifact with the same
 * status. **Both timings are covered here, and the property under test is that they produce the same
 * class**, because a controller that treated recorded evidence as a completion test would answer
 * differently for two records that establish the same thing.
 */
describe("an attempt recorded running is reconciled, not decided", () => {
  const A = "a".repeat(64);

  const runningVerdict = (over: Partial<RunningAttemptVerdict> = {}): RunningAttemptVerdict => ({
    kind: "attempt_running",
    artifactDigest: A,
    stageId: "script.oracle",
    attemptId: "att-10",
    ...over,
  });

  const decide = (
    verdict: RunningAttemptVerdict,
    over: Partial<ReworkInput> = {},
  ): ReworkDecision =>
    decideRework({ policy: policy(), rounds: [], verdict, fallbackGateId: FALLBACK, ...over });

  // The two legal timings from the ruling, as data, so every property below is asserted against
  // both rather than against whichever one a test author reached for.
  const timings: readonly [string, RunningAttemptVerdict][] = [
    [
      "killed before anything was written down",
      runningVerdict({ recordedCostIds: [], recordedArtifactDigests: [] }),
    ],
    [
      "killed one second later, with a charge and an artifact already recorded",
      runningVerdict({ recordedCostIds: ["cost-a"], recordedArtifactDigests: ["b".repeat(64)] }),
    ],
  ];

  it.each(timings)("reaches reconciliation_required when %s", (_timing, verdict) => {
    expect(decide(verdict).kind).toBe("reconciliation_required");
  });

  it.each(timings)("never converges, reworks or escalates when %s", (_timing, verdict) => {
    // The four arms this state must not fall into by default, asserted as absences rather than
    // inferred from the one it does reach: a mapping that returned `converged` would still satisfy
    // "produces a decision".
    const decision = decide(verdict);
    expect(decision.kind).not.toBe("converged");
    expect(decision.kind).not.toBe("rework");
    expect(decision.kind).not.toBe("escalate");
    // No gate, no stop reason, no candidate list — nothing that would route a fact-finding task to
    // a decision-making mechanism.
    expect(decision).not.toHaveProperty("gateId");
    expect(decision).not.toHaveProperty("reason");
    expect(decision).not.toHaveProperty("candidates");
  });

  it.each(timings)(
    "retains the exact attempt identity and evidence when %s",
    (_timing, verdict) => {
      const decision = decide(verdict);
      if (decision.kind !== "reconciliation_required") throw new Error(decision.kind);
      expect(decision.stageId).toBe("script.oracle");
      expect(decision.attemptId).toBe("att-10");
      expect(decision.artifactDigest).toBe(A);
      expect(decision.recordedCostIds).toEqual(verdict.recordedCostIds);
      expect(decision.recordedArtifactDigests).toEqual(verdict.recordedArtifactDigests);
    },
  );

  it("says the same thing about both timings, so evidence is not read as an outcome", () => {
    // The load-bearing case. Presence of a charge does not mean the round finished and absence does
    // not mean it did not; a controller inferring either would produce two different explanations
    // for two records that establish the same thing.
    const [, quiet] = timings[0] as [string, RunningAttemptVerdict];
    const [, charged] = timings[1] as [string, RunningAttemptVerdict];
    const first = decide(quiet);
    const second = decide(charged);
    if (first.kind !== "reconciliation_required") throw new Error(first.kind);
    if (second.kind !== "reconciliation_required") throw new Error(second.kind);
    expect(first.explanation).toBe(second.explanation);
  });

  it("explains the round, the uncertainty and the bounded remedy", () => {
    const decision = decide(runningVerdict(), {
      rounds: [round(1, "z".repeat(64), A)],
      policy: policy({ maxRounds: 5 }),
    });
    if (decision.kind !== "reconciliation_required") throw new Error(decision.kind);
    // The round it interrupts: two rounds are recorded as one here, so the interrupted one is 2.
    expect(decision.explanation).toContain("round 2");
    expect(decision.explanation).toContain("att-10");
    expect(decision.explanation).toContain("not established");
    // The remedy, named and not invoked, with the flag an operator has to type.
    expect(decision.explanation).toContain("--force");
    expect(decision.explanation).toContain("aldus run script.oracle");
  });

  it("never claims the attempt is dead or that a takeover is safe", () => {
    // The wording is the mechanism here. The runtime cannot tell a live dispatch from an abandoned
    // one, so a healthy in-flight evaluation reaches this same arm — and a sentence asserting death
    // or safety is the one an operator would act on.
    for (const [, verdict] of timings) {
      const decision = decide(verdict);
      if (decision.kind !== "reconciliation_required") throw new Error(decision.kind);
      // The disclaimers are removed before matching, because they legitimately contain the words a
      // false claim would use — asserting on the raw string would have been satisfied by deleting
      // them, which is the opposite of what is wanted here.
      expect(decision.explanation).toContain("not a statement that the attempt is dead");
      expect(decision.explanation).toContain("not a statement that a takeover is safe");
      const claimed = decision.explanation.replace(/not a statement that [^.]*/g, "");
      expect(claimed).not.toMatch(/\bis dead\b|\bhas died\b|\bsafe to (retry|take)/);
    }
  });

  it("returns the identical decision when the identical durable input is read again", () => {
    // Criterion 4, in the arm where a repeat is most dangerous: a restarted process re-reading the
    // same record must not produce a second remedy, and must not pay for anything.
    for (const [, verdict] of timings) {
      expect(decide(verdict)).toEqual(decide(verdict));
    }
  });

  it("outranks an approval, which cannot establish that a process is dead", () => {
    // `approvedContinuationDigests` clears the three continuable stops. It must not appear to clear
    // this one: the person at that gate was shown an artifact, not a machine.
    const decision = decide(runningVerdict(), { approvedContinuationDigests: [A] });
    expect(decision.kind).toBe("reconciliation_required");
  });

  it("outranks an exhausted bound, an oscillation and a missing policy", () => {
    // Precedence is the fail-closed direction: whatever else the history says, acting on it across
    // an unreconciled window is the thing that spends money twice.
    const exhausted = decide(runningVerdict(), {
      policy: policy({ maxRounds: 1 }),
      rounds: [round(1, A, "b".repeat(64))],
    });
    expect(exhausted.kind).toBe("reconciliation_required");

    const noPolicy = decideRework({
      rounds: [],
      verdict: runningVerdict(),
      fallbackGateId: FALLBACK,
    });
    expect(noPolicy.kind).toBe("reconciliation_required");
  });

  it("keeps a true not_evaluated input as no_evaluation", () => {
    // The two arms are adjacent and must stay distinct: `no_evaluation` asserts nothing ran, and
    // this state's whole content is that whether anything ran is unknown.
    const decision = decideRework({
      policy: policy(),
      rounds: [],
      verdict: { kind: "not_evaluated", artifactDigest: A, reason: "the stage failed" },
      fallbackGateId: FALLBACK,
    });
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.reason).toBe("no_evaluation");
    expect(decision.explanation).not.toContain("--force");
  });

  it("keeps evaluated clean and evaluated blocking unchanged", () => {
    expect(
      decideRework({
        policy: policy(),
        rounds: [],
        verdict: verdict({ blockingFindingClasses: [], observedFindingClasses: [] }),
        fallbackGateId: FALLBACK,
      }).kind,
    ).toBe("converged");

    expect(
      decideRework({ policy: policy(), rounds: [], verdict: verdict(), fallbackGateId: FALLBACK })
        .kind,
    ).toBe("rework");
  });

  describe("an identity that cannot be acted on is refused", () => {
    // Fail closed means refuse, not answer. A notice naming an empty attempt id points at nothing,
    // and a caller would read it as a reconciliation they can perform.
    const cases: readonly [string, Record<string, unknown>][] = [
      ["a missing attemptId", { attemptId: undefined }],
      ["an empty attemptId", { attemptId: "" }],
      ["a whitespace attemptId", { attemptId: "   " }],
      ["a mistyped attemptId", { attemptId: 10 }],
      ["a missing stageId", { stageId: undefined }],
      ["an empty stageId", { stageId: "" }],
      ["a mistyped stageId", { stageId: { id: "script.oracle" } }],
      ["a missing artifactDigest", { artifactDigest: undefined }],
      ["an empty artifactDigest", { artifactDigest: "" }],
      ["a mistyped artifactDigest", { artifactDigest: 42 }],
      ["a mistyped cost list", { recordedCostIds: "cost-a" }],
      ["a mistyped cost id", { recordedCostIds: [1] }],
      ["an empty cost id", { recordedCostIds: [""] }],
      ["a mistyped artifact list", { recordedArtifactDigests: {} }],
      ["a mistyped artifact digest", { recordedArtifactDigests: [null] }],
    ];

    it.each(cases)("refuses %s", (_name, over) => {
      const verdict = { ...runningVerdict(), ...over } as unknown as RunningAttemptVerdict;
      expect(() => decide(verdict)).toThrow(AldusError);
      try {
        decide(verdict);
      } catch (error) {
        const thrown = error as AldusError;
        expect(thrown.code).toBe("ALDUS_INVALID_REQUEST");
        expect(thrown.category).toBe("validation");
        // §19.2: the failing path and issue code only, never the received value.
        const issues = (thrown.details as { issues: { path: string; code: string }[] }).issues;
        expect(issues.length).toBeGreaterThan(0);
        for (const issue of issues) {
          expect(issue.code).toMatch(/^(invalid_type|empty_string)$/);
        }
        const serialised = JSON.stringify(thrown.toStructuredError());
        for (const value of Object.values(over)) {
          if (typeof value === "string" && value.trim().length > 0) {
            expect(serialised).not.toContain(value);
          }
        }
      }
    });

    it("accepts a verdict whose optional evidence is simply absent", () => {
      // Absent is not empty and is not invalid: it means nothing read it. Without this the case
      // above passes for a validator that refuses every running verdict.
      expect(decide(runningVerdict()).kind).toBe("reconciliation_required");
    });
  });
});
