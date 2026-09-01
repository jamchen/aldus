/**
 * Bounded rework (architecture contract §11, §12, §13; ADR-0055; #220).
 *
 * The first adopter's script process ran `candidate → oracle → blocking findings? revise and
 * evaluate again → clean? human freeze`. The human owned the final editorial freeze and **did not
 * decide every ordinary oracle round**. On Aldus that loop had nowhere to live: it became either a
 * `gate_required` per failed pass, which regresses an agent-driven process into repeated manual
 * routing, or an operator's shell loop, which is outside the record entirely.
 *
 * ADR-0055 fixes the boundary. Retry repeats an execution after an operational failure with its
 * input unchanged. **Rework consumes a finding, performs a declared repair, and produces a new
 * artifact** — the next evaluation's input is deliberately different, so nothing here is a retry of
 * anything. Producer judgement is a person deciding whether another round is warranted, and belongs
 * in a gate. What is left is a reviewed statement that named blocking findings require repair
 * within explicit bounds, and executing that statement is not a judgement anyone is making.
 *
 * Core names no finding classes, repair stages, or editorial thresholds (§4.2). Every such value
 * here is an opaque string the adopter supplies. What Core owns is that the policy is declared,
 * bounded, durable, and that its exits are decidable.
 */

import { z } from "zod";

import { actorRefSchema, iso8601, nonEmptyString, schemaVersionString } from "./common.js";

/**
 * Why a rework loop stopped without converging (ADR-0055, criteria 5 and 7).
 *
 * Every one of these terminates in a named `gate_required`. None of them accepts the artifact and
 * none of them keeps working: silent acceptance and unbounded work are the two failures the bound
 * exists to prevent, and an exit that did either would satisfy the letter of the policy while
 * removing its point.
 */
export const REWORK_STOP_REASONS = [
  /** The policy's `maxRounds` is spent. */
  "bounds_exhausted",
  /**
   * An artifact digest already produced by an earlier round came back.
   *
   * A → B → A is two clean-looking rounds and a loop that will never converge. This is the only
   * stop reason invisible to a controller that sees the latest verdict alone, which is why the
   * durable state is the round history rather than the last result.
   */
  "oscillation",
  /**
   * The evaluator reported a blocking finding class the policy does not cover.
   *
   * Not an error: a policy is a statement about the findings someone reviewed, and a class outside
   * it is exactly the case where a person should decide. Treating it as covered would let a policy
   * authorise rework nobody authorised.
   */
  "unknown_finding_class",
  /**
   * The verdict could not be read as blocking or clean.
   *
   * Distinct from a blocking verdict. An evaluator that failed to run fails its stage in the
   * ordinary way; this is the case where it ran and what it said cannot be classified — and
   * guessing is how a crashed checker gets counted as a clean one.
   */
  "ambiguous_verdict",
  /**
   * The repair made it worse: more findings came back than went in.
   *
   * Distinct from oscillation, which needs a digest to repeat. A loop can produce a different
   * artifact every round and get steadily worse, spending its whole bound and every paid repair on
   * the way down — and each round looks like progress to a controller comparing digests.
   *
   * Reported by the first adopter from a real run: a repair round took a script from 4 findings to
   * 7 **by adding explanation**, and narration grew 2,246 → 2,551 → 2,904 characters across three
   * rounds. A comprehension evaluator reads a longer script with more connective tissue as an
   * improvement, so the loop can make a commentary script worse while every number it watches says
   * better. This is the number that says worse.
   */
  "regression",
  /**
   * No evaluation is recorded for the artifact at all.
   *
   * Distinct from `ambiguous_verdict`, where an evaluator ran and its result could not be
   * classified. Here nothing ran, or what ran left no classifiable record — a stage that failed, an
   * attempt that never evaluated, a report that could not be parsed. An absent evaluation is not a
   * passing one, and the remedy differs: an ambiguous verdict needs a person to read it, and a
   * missing one needs the evaluation to happen.
   *
   * **Not an attempt durably recorded as `running`** (ADR-0057, #220). This arm asserts that
   * nothing ran; a running attempt's whole content is that whether anything ran is unknown, and its
   * remedy is for someone to establish whether the process is dead rather than for anyone to
   * decide. That state is deliberately absent from this list: it terminates in no gate, so it is
   * not a stop reason. Adding it here is the alternative ADR-0057 rejects.
   */
  "no_evaluation",
  /** No policy covers this stage, so every blocking finding is a person's decision. */
  "no_policy",
] as const;

/** @see REWORK_STOP_REASONS */
export type ReworkStopReason = (typeof REWORK_STOP_REASONS)[number];

/**
 * A declared, bounded rework policy (ADR-0055).
 *
 * **The bound is an authorised value, not a configuration setting.** `authorizationId` names the
 * decision that authorised it, because a cap an operator can raise mid-run by editing a config file
 * is not a bound — it is a default, and the record cannot tell the difference afterwards.
 */
export const reworkPolicySchemaBase = z
  .object({
    schemaVersion: schemaVersionString,
    policyId: nonEmptyString,
    /** The evaluating stage whose blocking findings this policy answers. */
    stageId: nonEmptyString,
    /**
     * The declared repair operation.
     *
     * A stage id, so the repair is an ordinary recorded execution with its own attempt, artifacts,
     * provenance and cost. A repair performed outside the graph would be the shell loop again.
     */
    repairStageId: nonEmptyString,
    /**
     * Which blocking finding classes this policy covers. Opaque to Core (§4.2).
     *
     * Enumerated rather than "all blocking findings", so the policy states what was reviewed. A
     * class outside this list escalates rather than being reworked — see `unknown_finding_class`.
     */
    coversFindingClasses: z.array(nonEmptyString).min(1),
    /** Maximum rework rounds. At least one, or the policy authorises nothing. */
    maxRounds: z.int().min(1),
    /**
     * Where an unconverged loop lands.
     *
     * Required. Every automatic exit terminates here, and before `0.2.0-next.35` an unregistered id
     * recorded a permanent silent `waiting_for_gate` no approval could clear — an escalation that
     * cannot be decided is worse than no escalation, because it looks like the loop stopped safely.
     */
    escalateToGateId: nonEmptyString,
    /**
     * The artifact kind this loop repairs — the *candidate*, not the evaluator's report.
     *
     * Declared because the join cannot be inferred. A repair stage may consume and produce several
     * artifacts and an evaluator's own output is normally its report, so `outputArtifacts.at(-1)`
     * identifies whatever happens to be last in an array whose order the contract gives no meaning
     * to. Reading a round out of array position is not lineage; it is a guess that looks like one.
     *
     * Opaque to Core (§4.2) — the adopter names their own kinds. What Core owns is that the loop
     * refuses a round it cannot join rather than inferring one.
     */
    candidateArtifactKind: nonEmptyString,
    /** The decision that authorised this bound (§13). */
    authorizationId: nonEmptyString,
    /**
     * The asymmetric harm of unnecessary automatic correction, as the authorising party weighed it
     * (§12.1; ADR-0056).
     *
     * Required, because a policy may cover a class whose channel is `advisory` — which is the
     * ordinary case for a model-assisted evaluator with no promotion evidence, and the population
     * that most needs a loop. §12.1 lists this harm among what promotion must consider, and a
     * bounded loop does not make the consideration go away; it moves it to whoever authorises the
     * policy.
     *
     * A weak mechanism, labelled as one. It catches an author who never considered the question and
     * cannot catch a bad answer — the same shape, and the same justification, as `verified at:` in
     * the evidence block: the move for an invisible omission is a required field.
     */
    automaticCorrectionHarm: nonEmptyString,
  })
  .meta({
    id: "ReworkPolicy",
    title: "ReworkPolicy",
    description:
      "A declared, bounded, reviewable policy stating that named blocking findings require a " +
      "declared repair and re-evaluation within explicit bounds (ADR-0055).",
  });

/** @see reworkPolicySchemaBase */
export type ReworkPolicy = z.infer<typeof reworkPolicySchemaBase>;

/**
 * One completed rework round (ADR-0055, criterion 6).
 *
 * Append-only, and the controller's durable state is the list of these rather than the latest
 * verdict. Oscillation is a property of the history, so a controller built on the last result
 * satisfies every other criterion and cannot implement that one.
 */
export const reworkRoundSchemaBase = z
  .object({
    schemaVersion: schemaVersionString,
    policyId: nonEmptyString,
    runId: nonEmptyString,
    /** 1-based. The first repair is round 1. */
    roundIndex: z.int().min(1),
    /** Digest of the artifact the evaluator judged to open this round. */
    inputDigest: nonEmptyString,
    /** Which finding classes the repair consumed. Opaque to Core (§4.2). */
    consumedFindingClasses: z.array(nonEmptyString),
    /**
     * How many policy-covered findings the evaluator enumerated at this round's **input**.
     *
     * Occurrences, not classes: a repair that turns two problems into five may leave the class list
     * unchanged, and the class list is what a controller would otherwise have to compare. Take it
     * from `AttemptMetadata.evaluationEvidence.enumeratedFindings`.
     *
     * Optional, and absence is honest rather than convenient: a round recorded before this field,
     * or by an evaluator whose evidence is reports rather than enumerated findings, has no count to
     * compare. The regression arm then cannot fire — a hole, and named as one, because inferring a
     * count from an unmeasurable evidence form is the exact move `defectCountMeasurable` exists to
     * prevent.
     */
    inputFindingCount: z.int().nonnegative().optional(),
    /** The repair execution, so the round points at its own provenance and cost. */
    repairStageId: nonEmptyString,
    repairAttemptId: nonEmptyString,
    /** Digest of the artifact the repair produced, and the next evaluation's input. */
    outputDigest: nonEmptyString,
    /** Cost records attributed to this round (§19.3). */
    costIds: z.array(nonEmptyString).default([]),
    /** Who ran it. A policy executes without a judgement, but not without an actor (§19.2). */
    actor: actorRefSchema,
    at: iso8601,
  })
  .meta({
    id: "ReworkRound",
    title: "ReworkRound",
    description:
      "One completed repair-and-re-evaluate round, carrying the digests, findings consumed, " +
      "repair execution, cost and actor that make the loop reviewable (ADR-0055).",
  });

/** @see reworkRoundSchemaBase */
export type ReworkRound = z.infer<typeof reworkRoundSchemaBase>;
