/**
 * The bounded rework controller (ADR-0055; #220).
 *
 * A pure decision over durable state, deliberately: the loop must resume correctly in a process
 * that has no memory of the previous rounds (criterion 4), and a controller holding state in a
 * session cannot be resumed by the next one. Everything it needs is the policy, the round history,
 * and the latest verdict — all of which are on disk.
 *
 * It lives above the graph rather than inside it. ADR-0028's DAG keeps its static ordering
 * guarantees and gains no back-edge; iteration is a controller's decision about which stage runs
 * next, which is what a shell loop was doing unrecorded.
 */

import type { ReworkPolicy, ReworkRound, ReworkStopReason } from "@aldus-runtime/core";

/**
 * What the evaluator said about the current artifact.
 *
 * `findingClasses` are the classes the stage's **declared channels** already classified as
 * blocking (§12.1, ADR-0037). The controller never reads observations and never decides what
 * blocks: a controller that could reclassify a finding would be a stage promoting its own findings
 * with extra steps.
 */
export type ReworkVerdict = EvaluatedVerdict | NoEvaluationVerdict;

/**
 * No evaluation is recorded for this artifact (#220).
 *
 * **Representable on purpose, and required rather than inferable.** The previous shape had a single
 * verdict type whose empty state — no blocking classes, no observed classes — meant *"the evaluator
 * ran and found nothing"*. An attempt with no evaluation recorded at all produces exactly the same
 * empty state, so a caller reading `enumeratedFindings: 0` off a record and passing it through got
 * `converged`: a non-answer read as a pass, in the arm that releases the next stage.
 *
 * The first adopter has a real instance. Their oracle skipped its output contract four times in
 * forty — delivering prose with no fenced block — and the analysis was real while the structure was
 * missing. Their stage throws, so their loop sees a stage failure, which is right. A controller that
 * took the zero at face value would have called it clean.
 *
 * Splitting the type is what makes that unrepresentable: a caller cannot assert an empty evaluation
 * without saying an evaluation happened.
 */
export interface NoEvaluationVerdict {
  kind: "not_evaluated";
  artifactDigest: string;
  /** Why there is no evaluation — a stage failure, a missing attempt, an unparsed report. */
  reason: string;
}

/** The evaluator ran and produced a classifiable result. */
export interface EvaluatedVerdict {
  kind: "evaluated";
  /** Digest of the artifact this verdict is about. A verdict applies to nothing else (criterion 8). */
  artifactDigest: string;
  /**
   * Blocking finding classes, as classified by the stage's declared enforcement.
   *
   * Empty means nothing stops work. It does **not** mean nothing was found: a model-assisted
   * evaluator with no promotion evidence declares every channel `advisory` (§12.1), so this list is
   * empty for exactly the evaluators most likely to need a repair loop.
   */
  blockingFindingClasses: readonly string[];
  /**
   * Every finding class the evaluator emitted, blocking or not (ADR-0056).
   *
   * Read straight from the attempt's recorded observations. The controller does not decide what any
   * of them means — enforcement decides what stops work, and the policy decides what warrants a
   * repair round. Those are different licences and neither substitutes for the other.
   */
  observedFindingClasses: readonly string[];
  /**
   * How many findings the evaluator enumerated, when that is measurable.
   *
   * From `AttemptMetadata.evaluationEvidence` — and only when `defectCountMeasurable` is true. A
   * report states that an evaluator had something to say and not how much, so a count over
   * report-shaped evidence is not a smaller number, it is not a number (#140).
   *
   * Absent means the regression arm cannot fire. That is a hole rather than a pass, and it is named
   * in the decision's own docstring rather than left for a reader to discover.
   */
  findingCount?: number;
  /**
   * The evaluator ran and what it said could not be classified.
   *
   * Distinct from a blocking verdict and from a failure. A stage whose evaluator could not execute
   * fails in the ordinary way; this is where it ran and the result is unreadable, and guessing is
   * how a crashed checker gets counted as a clean one.
   */
  ambiguous?: boolean;
}

/** What the controller decided to do next. */
export type ReworkDecision =
  /** Nothing blocks. The next workflow stage is released. */
  | { kind: "converged"; artifactDigest: string }
  /**
   * Run the declared repair, then evaluate again.
   *
   * `round` is 1-based and is the round this repair will *become*, so a caller writing the
   * `ReworkRound` record does not have to re-derive it and get it off by one.
   */
  | {
      kind: "rework";
      round: number;
      repairStageId: string;
      consumeFindingClasses: readonly string[];
      inputDigest: string;
    }
  /**
   * Hand it to a person, at a named gate, with a reason.
   *
   * Every automatic exit lands here. `explanation` is operator-facing and states what stopped the
   * loop rather than what state it is in — an operator reading "bounds_exhausted" alone has to go
   * looking for the bound.
   */
  | {
      kind: "escalate";
      gateId: string;
      reason: ReworkStopReason;
      explanation: string;
      /** The artifact the loop stopped on. The **latest**, which is not the same as the best. */
      artifactDigest: string;
      /**
       * Every artifact this loop produced, oldest first, with what was measured about it.
       *
       * **Reported, never ranked.** The loop always carries the newest candidate forward, and after
       * a regression the useful artifact is an earlier one — so a person deciding this gate needs
       * to see the alternatives, and today every adopter would reimplement finding them.
       *
       * Core does not pick, and the reason is the adopter's own evidence rather than §4.2 alone: a
       * repair that *cut* a load-bearing clause produces **fewer** findings and a worse script, so
       * ordering by count would recommend exactly the artifact their
       * `automaticCorrectionHarm` warns about. Fewer findings is not better; it is fewer findings.
       * The person at the gate is who §13 says decides, and this hands them what they need to.
       *
       * `findingCount` is absent wherever it was absent on the round — a hole, not a zero.
       */
      candidates: readonly { digest: string; findingCount?: number }[];
    };

/** The state a decision is taken against. All of it durable (criterion 4). */
export interface ReworkInput {
  /** Absent when no policy covers this stage — then every blocking finding is a person's call. */
  policy?: ReworkPolicy;
  /** Completed rounds for this policy and Run, oldest first. */
  rounds: readonly ReworkRound[];
  verdict: ReworkVerdict;
  /**
   * Artifact digests the escalation gate has approved continuing from.
   *
   * **A gate that lets a person overrule a stop cannot overrule one of five causes and not the
   * rest.** Named by the first adopter, who raised their bound after an escalation and found the
   * loop still stopped — on a fact about the history, while the person was answering a question
   * about the next round. A gate that appears to release the loop and does not is worse than one
   * that never offered.
   *
   * So an approval clears whichever of the *continuable* stops fired: the bound being spent, a
   * regression, an oscillation. The person at that gate was shown the reason and the candidates,
   * and deciding anyway is what the gate is for.
   *
   * It does not clear `no_evaluation`, `unknown_finding_class` or `no_policy`, and the line is
   * **meaningful versus impossible rather than mild versus severe**: an approval can authorise more
   * work, and cannot supply an evaluation that was never recorded, a repair instruction for a class
   * nobody covered, or a policy that does not exist.
   *
   * **Digests rather than a count**, and that is the load-bearing part. A count of approvals cannot
   * say *which* stop was approved: one approval would suppress a regression three rounds later that
   * nobody had seen. §13 already binds a decision to its subjects, so an approval of the artifact
   * the loop stopped on authorises continuing **from that artifact** — and it stops applying the
   * moment the loop produces a different one, without any arithmetic to get wrong.
   */
  approvedContinuationDigests?: readonly string[];
  /**
   * Where an escalation lands when there is no policy to name a gate.
   *
   * Required by the caller rather than defaulted here, because a gate id Core invented would be
   * one no registry holds — and an escalation to an unregistered gate is a permanent silent stop
   * that looks like the loop halted safely (#221).
   */
  fallbackGateId: string;
}

/**
 * Decide the next action for a bounded rework loop (ADR-0055).
 *
 * Order matters and is not arbitrary. Convergence is checked first, because a clean verdict ends
 * the loop no matter how many rounds preceded it — an exhausted bound must not escalate an artifact
 * that already passed. Ambiguity comes next, because an unreadable verdict is not evidence of
 * anything and must never be read as either outcome.
 */
export function decideRework(input: ReworkInput): ReworkDecision {
  const { policy, rounds, verdict } = input;
  const digest = verdict.artifactDigest;

  // Every artifact this loop has seen, oldest first: each round's input, then the one under
  // judgement now. Built once, attached to every escalation, and never ordered — see `candidates`.
  const candidates: { digest: string; findingCount?: number }[] = [
    ...rounds.map((round) => ({
      digest: round.inputDigest,
      ...(round.inputFindingCount === undefined ? {} : { findingCount: round.inputFindingCount }),
    })),
    {
      digest,
      ...(verdict.kind === "evaluated" && verdict.findingCount !== undefined
        ? { findingCount: verdict.findingCount }
        : {}),
    },
  ];

  // First, and before anything reads a finding list. An artifact with no evaluation has no empty
  // finding list — it has no finding list — and the two were indistinguishable while one type
  // carried both.
  if (verdict.kind === "not_evaluated") {
    return {
      kind: "escalate",
      gateId: policy?.escalateToGateId ?? input.fallbackGateId,
      reason: "no_evaluation",
      explanation:
        `No evaluation is recorded for this artifact: ${verdict.reason}. Nothing here establishes ` +
        "that it is clean, and an absent evaluation is not a passing one.",
      artifactDigest: digest,
      candidates,
    };
  }

  // A verdict the enforcement could not classify is not a clean one and not a blocking one.
  if (verdict.ambiguous === true) {
    return {
      kind: "escalate",
      gateId: policy?.escalateToGateId ?? input.fallbackGateId,
      reason: "ambiguous_verdict",
      explanation:
        "The evaluator ran and its verdict could not be classified as blocking or clean, so " +
        "neither accepting the artifact nor reworking it is supported by evidence.",
      artifactDigest: digest,
      candidates,
    };
  }

  // Nothing stops work and nothing the policy covers was found. Under ADR-0055 this read only the
  // blocking list, so an artifact with four advisory findings a policy explicitly covers converged
  // — and for a model-assisted evaluator, which cannot declare a blocking channel without promotion
  // evidence, that was every artifact. The loop was unreachable for the population that needed it.
  const covers = (cls: string): boolean => policy?.coversFindingClasses.includes(cls) === true;
  const repairable = verdict.observedFindingClasses.filter(covers);
  if (verdict.blockingFindingClasses.length === 0 && repairable.length === 0) {
    return { kind: "converged", artifactDigest: digest };
  }

  if (policy === undefined) {
    return {
      kind: "escalate",
      gateId: input.fallbackGateId,
      reason: "no_policy",
      explanation:
        "A blocking finding was reported and no declared rework policy covers this stage, so " +
        "whether to rework is a person's decision (ADR-0055).",
      artifactDigest: digest,
      candidates,
    };
  }

  // A **blocking** class outside the policy is exactly the case a person should see: enforcement
  // stopped work and the policy cannot repair it, so no bounded round can resolve it. An *advisory*
  // class outside the policy is not an escalation — it is a finding the adopter chose to record and
  // not act on, which is what advisory means.
  const covered = new Set(policy.coversFindingClasses);
  const uncovered = verdict.blockingFindingClasses.filter((cls) => !covered.has(cls));
  if (uncovered.length > 0) {
    return {
      kind: "escalate",
      gateId: policy.escalateToGateId,
      reason: "unknown_finding_class",
      explanation:
        `Policy "${policy.policyId}" does not cover blocking finding class(es) ` +
        `${uncovered.join(", ")}, so this round was not authorised in advance.`,
      artifactDigest: digest,
      candidates,
    };
  }

  // Whether a person has approved continuing from **this** artifact. The three continuable stops
  // all defer to it, because a gate that clears one of them and not the others appears to release
  // the loop and does not.
  const approvedHere = input.approvedContinuationDigests?.includes(digest) === true;

  // Getting worse. Checked before oscillation and before the bound, because a loop that is
  // measurably degrading should not spend another authorised round or another paid repair proving
  // it — and unlike oscillation this needs no digest to repeat, so it fires on the first bad round.
  //
  // Occurrences rather than classes: a repair that turns two problems into five may leave the class
  // list unchanged, and the adopter's real case was 4 findings to 7 from one round that made the
  // script longer. Only when both counts are present and measurable; otherwise the arm is silent,
  // which is a hole rather than a clean bill.
  const previous = rounds.at(-1);
  const before = previous?.inputFindingCount;
  const now = verdict.findingCount;
  if (
    !approvedHere &&
    previous !== undefined &&
    before !== undefined &&
    now !== undefined &&
    now > before
  ) {
    return {
      kind: "escalate",
      gateId: policy.escalateToGateId,
      reason: "regression",
      explanation:
        `The last repair increased findings from ${before} to ${now}. A repair that makes the ` +
        "artifact worse will not be improved by repeating it, and the remaining rounds would be " +
        "spent going further in that direction.",
      artifactDigest: digest,
      candidates,
    };
  }

  // Oscillation, and the reason the durable state is the history rather than the last verdict:
  // A → B → A is two clean-looking rounds and a loop that will never converge. Checked before the
  // bound, because a loop that is provably not progressing should not spend its remaining rounds
  // proving it again.
  //
  // The predicate is "an artifact this loop already evaluated has come back", so it reads the
  // **input** digests. Comparing against outputs was the first attempt and it flags the ordinary
  // flow: the artifact a round produced is exactly what the next evaluation judges, so every
  // healthy second round looked like a cycle. Two tests caught it — the round-numbering case and
  // the bound-exhaustion case — before the one it was written for ever ran.
  if (!approvedHere && rounds.some((round) => round.inputDigest === digest)) {
    return {
      kind: "escalate",
      gateId: policy.escalateToGateId,
      reason: "oscillation",
      explanation:
        "An artifact digest an earlier round already produced has come back, so the repair is " +
        "cycling rather than converging and further rounds cannot be expected to help.",
      artifactDigest: digest,
      candidates,
    };
  }

  if (!approvedHere && rounds.length >= policy.maxRounds) {
    return {
      kind: "escalate",
      gateId: policy.escalateToGateId,
      reason: "bounds_exhausted",
      explanation:
        `Policy "${policy.policyId}" authorised ${policy.maxRounds} rework round(s) and all of ` +
        "them are spent, so continuing would be work nobody authorised.",
      artifactDigest: digest,
      candidates,
    };
  }

  return {
    kind: "rework",
    round: rounds.length + 1,
    repairStageId: policy.repairStageId,
    // What the repair is being asked to fix: the covered classes actually observed. Not the
    // blocking list, which is empty for an uncalibrated evaluator, and not everything observed,
    // which would hand the repair classes nobody authorised it to act on.
    consumeFindingClasses: repairable,
    inputDigest: digest,
  };
}
