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
export interface ReworkVerdict {
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
      artifactDigest: string;
    };

/** The state a decision is taken against. All of it durable (criterion 4). */
export interface ReworkInput {
  /** Absent when no policy covers this stage — then every blocking finding is a person's call. */
  policy?: ReworkPolicy;
  /** Completed rounds for this policy and Run, oldest first. */
  rounds: readonly ReworkRound[];
  verdict: ReworkVerdict;
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
  if (rounds.some((round) => round.inputDigest === digest)) {
    return {
      kind: "escalate",
      gateId: policy.escalateToGateId,
      reason: "oscillation",
      explanation:
        "An artifact digest an earlier round already produced has come back, so the repair is " +
        "cycling rather than converging and further rounds cannot be expected to help.",
      artifactDigest: digest,
    };
  }

  if (rounds.length >= policy.maxRounds) {
    return {
      kind: "escalate",
      gateId: policy.escalateToGateId,
      reason: "bounds_exhausted",
      explanation:
        `Policy "${policy.policyId}" authorised ${policy.maxRounds} rework round(s) and all of ` +
        "them are spent, so continuing would be work nobody authorised.",
      artifactDigest: digest,
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
