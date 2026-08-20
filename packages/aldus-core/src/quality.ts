/**
 * The quality model, shared by everything that can make a quality claim (contract §12).
 *
 * §12 describes quality mechanisms in general terms — four levels, and a rule about what may
 * block. Until #115 the whole model lived in `gate-engine` and existed nowhere else, so a gate
 * could declare a level and carry calibration evidence while a Stage running the same evaluator
 * could declare nothing at all. Adopters run evaluators as Stages, so §12 was enforced at one of
 * the two places it applies.
 *
 * These concepts are therefore Core's rather than gates'. `gate-engine` re-exports the gate-shaped
 * names it already published, so nothing that consumed `GateLevel` has to change.
 */

/**
 * How a quality mechanism reaches its verdict (contract §12).
 *
 * The four levels, verbatim from §12:
 *
 * 1. **Hard deterministic gate** — blocks on objectively testable failure.
 * 2. **Advisory signal** — reports a possible issue without blocking.
 * 3. **Model-assisted semantic review** — evaluates meaning, stance, style, or claims with
 *    uncertainty.
 * 4. **Human oracle** — owns subjective judgment or asymmetric-risk decisions.
 *
 * The level follows from **the nature of the judgement**, not from how noisy the mechanism turns
 * out to be. A declared deterministic rule objectively decides whether its condition is present,
 * and stays level 1 even if the rule is a poor one — that makes it a bad rule to fix, not an
 * uncalibrated evaluator to refuse. Equally, a rule that concerns prose is not thereby
 * model-assisted: the determination comes from the rule's semantics and implementation, never
 * from its provenance or from where it happens to run.
 */
export const QUALITY_LEVELS = [
  /** Blocks on an objectively testable failure (§12 level 1). */
  "hard_gate",
  /** Reports a possible issue without blocking (§12 level 2). */
  "advisory_signal",
  /** Evaluates meaning, stance, style, or claims under uncertainty (§12 level 3). */
  "model_assisted",
  /** A human owns the judgement, because it is subjective or asymmetric-risk (§12 level 4). */
  "human_oracle",
] as const;

/** @see QUALITY_LEVELS */
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

/**
 * Whether a quality mechanism stops work or merely reports (contract §12).
 *
 * Deliberately a two-state enumeration rather than a boolean. §12.1 permits an evaluator to
 * *become* blocking only after calibration, which makes this a promotion with evidence behind it
 * — and a field named `blocking: boolean` invites someone to flip it in a config file without
 * producing any.
 *
 * Separate from {@link QualityLevel} because §12's own table pairs them freely: a hard gate
 * blocks, an advisory signal does not, and a model-assisted review may do either depending on
 * whether it has been calibrated.
 */
export const QUALITY_ENFORCEMENTS = ["blocking", "advisory"] as const;

/** @see QUALITY_ENFORCEMENTS */
export type QualityEnforcement = (typeof QUALITY_ENFORCEMENTS)[number];

/**
 * Evidence that a model-assisted evaluator was calibrated before it was allowed to block.
 *
 * Contract §12.1: *"An evaluator MAY become blocking only after it is calibrated against
 * human-labeled examples."* The metrics themselves belong to WP-10; this is the reference a
 * declaration must carry to claim they exist.
 *
 * `scope` matters as much as the numbers. §12.1 lists show, host, voice, model, and script-form
 * scope among what promotion must consider, because an evaluator calibrated on one host says
 * nothing about another — and evidence for one scope must not silently authorize blocking outside
 * it. Dimensions are caller-supplied (§4.2), consistent with WP-09's packs.
 */
export interface PromotionEvidence {
  /** Identifier of the calibration report that justified promotion (WP-10). */
  reportRef: string;
  /** Scope the calibration covers, e.g. `{ host: "example-host", voice: "voice-a" }`. */
  scope: Record<string, string>;
  /** Known blind spots recorded at promotion time (§12.1, §9.3). */
  knownBlindSpots?: string[];
}

/** Why a quality claim is internally inconsistent. */
export interface QualityClaimProblem {
  kind:
    | "uncalibrated-blocking"
    | "advisory-signal-blocking"
    | "malformed-evidence"
    | "undefined-combination";
  /** One sentence naming what is wrong, for an operator rather than a log. */
  message: string;
}

/**
 * Everything wrong with one quality claim, or an empty list (contract §12, §12.1).
 *
 * Shared so a gate and an evaluator Stage are refused for the same reasons in the same words.
 * Two implementations of one clause is how #115 happened.
 *
 * What this does **not** do is judge whether a claim is *true*. Aldus defines the available claims
 * and the evidence each requires; whether a given rule is genuinely deterministic is a fact about
 * the adopter's implementation, and refusing a valid declaration because its subject is prose
 * would be Aldus reclassifying an adopter's rule from the outside.
 */
export function validateQualityClaim(claim: {
  level: QualityLevel;
  enforcement: QualityEnforcement;
  promotionEvidence?: PromotionEvidence | undefined;
}): readonly QualityClaimProblem[] {
  const problems: QualityClaimProblem[] = [];

  if (claim.level === "model_assisted" && claim.enforcement === "blocking") {
    if (claim.promotionEvidence === undefined) {
      problems.push({
        kind: "uncalibrated-blocking",
        message:
          "A model-assisted evaluator may block only after calibration against human-labeled " +
          "examples (contract §12.1), so a blocking declaration must carry promotion evidence. " +
          "Declare it advisory until the evidence exists.",
      });
    }
  }

  if (claim.level === "advisory_signal" && claim.enforcement === "blocking") {
    problems.push({
      kind: "advisory-signal-blocking",
      message:
        "An advisory signal reports a possible issue without blocking (contract §12 level 2), so " +
        "declaring one blocking is a contradiction rather than a stricter policy. A check that " +
        "should stop work is a hard gate if its condition is objectively testable, and a " +
        "model-assisted evaluator with evidence if it is not.",
    });
  }

  const evidence = claim.promotionEvidence;
  if (evidence !== undefined) {
    if (evidence.reportRef.trim().length === 0) {
      problems.push({
        kind: "malformed-evidence",
        message:
          "Promotion evidence names no calibration report, so nothing can be checked against it " +
          "later. §12.1's evidence is a reference to metrics, not an assertion that they exist.",
      });
    }
    if (Object.keys(evidence.scope).length === 0) {
      problems.push({
        kind: "malformed-evidence",
        message:
          "Promotion evidence declares no scope. §12.1 requires promotion to consider show, host, " +
          "voice, model and script form, because an evaluator calibrated on one says nothing " +
          "about another — unscoped evidence would authorize blocking everywhere.",
      });
    }
  }

  return problems;
}
