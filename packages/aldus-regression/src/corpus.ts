/**
 * The defect corpus (architecture contract §22 WP-10, §12.1, §12.3, §24).
 *
 * §12.1 permits an evaluator to become blocking "only after it is calibrated against
 * human-labeled examples", and §24 requires that "a representative defect corpus is executed
 * during regression testing". This module defines what such a corpus is.
 *
 * Two shapes here are deliberately open rather than enumerated:
 *
 * - **Finding categories.** §12.3 presents its taxonomy as "for example", and §4.2 keeps
 *   adopter concepts out of the runtime. A category is an opaque caller-supplied string.
 * - **Severity levels.** Likewise named by the caller. The *weights* live in the promotion
 *   policy, so an adopter can say a missed pronunciation error costs less than a missed
 *   unsupported claim without Core deciding that for them.
 *
 * The human label is the oracle (§12 level 4). Nothing in this module treats an evaluator's
 * output as ground truth.
 *
 * Zod is the single source of truth; TypeScript types are inferred (ADR-0002).
 */

import { actorRefSchema, SCHEMA_VERSION } from "@aldus-runtime/core";
import { z } from "zod";

import { RegressionErrorCodes, regressionError } from "./errors.js";

/** A short opaque identifier. */
const identifier = z.string().min(1).max(200);

/**
 * A finding category, structured per contract §12.3.
 *
 * An OPEN string, never a Core-defined enum. §12.3 introduces its taxonomy with "for example",
 * and §4.2 forbids Core from owning an adopter's diagnosis vocabulary. Do not narrow this to a
 * union.
 */
export const findingCategory = z.string().min(1).max(200);

/**
 * A severity level, named by the caller.
 *
 * An OPEN string for the same reason as {@link findingCategory}. Ordering and weighting are
 * supplied by the promotion policy, not inferred from the name — a package that decided
 * `"critical"` outranks `"major"` would be guessing at an adopter's scale.
 */
export const severityLevel = z.string().min(1).max(100);

/**
 * Scope dimensions a case belongs to (contract §12.1 "show, host, voice, model, and
 * script-form scope").
 *
 * `Record<string, string>`, consistent with Knowledge Pack scope (§9.2, ADR-0006). §12.1's list
 * is illustrative and §4.2 forbids naming a provider, so dimensions stay caller-supplied.
 */
export const scopeDimensions = z.record(z.string().min(1).max(100), z.string().min(1).max(200));

/** @see scopeDimensions */
export type ScopeDimensions = z.infer<typeof scopeDimensions>;

/** One defect a human labeller identified in a case. */
export const humanFindingSchema = z
  .object({
    /** Category from the adopter's taxonomy (contract §12.3). */
    category: findingCategory,
    /** Severity from the adopter's scale; weighted by the promotion policy. */
    severity: severityLevel,
    /** What the labeller saw. Prose, never parsed. */
    note: z.string().max(4000).optional(),
  })
  .meta({ id: "HumanFinding", title: "HumanFinding" });

/** @see humanFindingSchema */
export type HumanFinding = z.infer<typeof humanFindingSchema>;

/**
 * One labelled case: an input, and what a human said about it.
 *
 * The case does not carry the input itself. §8.1 makes artifacts addressable by ID and hash, and
 * a corpus that embedded audio or scripts would be unreviewable and would risk carrying private
 * source material into a test fixture (§19.2). `subjectRef` points at the subject; what it
 * points into is the caller's business.
 */
export const defectCaseSchema = z
  .object({
    /** Identity of this case within its corpus. */
    caseId: identifier,
    /** Reference to the material under test — an artifact ID, hash, or adopter-defined locator. */
    subjectRef: z.string().min(1).max(1024),
    /** Scope this case belongs to (contract §12.1). */
    scope: scopeDimensions,
    /**
     * Whether a human judged the subject defective. **This is the oracle** (§12 level 4).
     *
     * Stored separately from `findings` so a case can be labelled clean explicitly. An empty
     * findings array on a case nobody reviewed is not the same claim as "a human looked and
     * found nothing", and conflating them would inflate the true-negative count with unreviewed
     * material.
     */
    defective: z.boolean(),
    /** What the labeller found. Empty when `defective` is false. */
    findings: z.array(humanFindingSchema).max(256),
    /**
     * Overall severity of the case, used for severity-weighted metrics (contract §12.1).
     *
     * Required when `defective`, absent otherwise — enforced by refinement below.
     */
    severity: severityLevel.optional(),
    /**
     * Correction class this case would trigger if a blocking evaluator flagged it.
     *
     * §12.1 names "asymmetric harm caused by unnecessary automatic correction" as its own
     * consideration, and §12.4 makes the repair layer explicit — regenerating one TTS segment
     * and revising narration with cascading approval invalidation are not the same act. This
     * names which one a flag would trigger here; the policy assigns the harm weight. Absent
     * means the policy's default class applies.
     */
    correctionOnFlag: identifier.optional(),
    /** Who labelled the case (contract §19.2: a decision without an actor is not a decision). */
    labelledBy: actorRefSchema,
    /** When the label was recorded. */
    labelledAt: z.iso.datetime({ offset: true }),
  })
  .refine((value) => value.defective === (value.severity !== undefined), {
    message:
      "a defective case must carry a severity, and a clean case must not (architecture contract §12.1 requires severity-weighted metrics)",
    path: ["severity"],
  })
  .refine((value) => value.defective || value.findings.length === 0, {
    message: "a case labelled clean must carry no findings",
    path: ["findings"],
  })
  .meta({
    id: "DefectCase",
    title: "DefectCase",
    description:
      "One human-labelled case in a defect corpus (architecture contract §12.1, §24). The human " +
      "label is the oracle; nothing treats an evaluator's output as ground truth. `category` and " +
      "`severity` are open strings because §12.3's taxonomy is illustrative and §4.2 keeps " +
      "adopter vocabularies out of the runtime. ADDITIONAL CONSTRAINTS NOT EXPRESSIBLE IN JSON " +
      "SCHEMA: a defective case must carry a severity and a clean case must not, and a clean " +
      "case must carry no findings.",
  });

/** @see defectCaseSchema */
export type DefectCase = z.infer<typeof defectCaseSchema>;

/** A named, versioned set of labelled cases. */
export const defectCorpusSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    /** Identity of this corpus. */
    corpusId: identifier,
    /** Human-readable purpose. */
    description: z.string().max(2000).optional(),
    /** The labelled cases. */
    cases: z.array(defectCaseSchema).max(100_000),
  })
  .meta({
    id: "DefectCorpus",
    title: "DefectCorpus",
    description:
      "A defect corpus: human-labelled cases an evaluator is calibrated against (architecture " +
      "contract §12.1, §24). ADDITIONAL CONSTRAINT NOT EXPRESSIBLE IN JSON SCHEMA: `caseId` " +
      "must be unique within the corpus.",
  });

/** @see defectCorpusSchema */
export type DefectCorpus = z.infer<typeof defectCorpusSchema>;

/** One finding an evaluator reported. */
export const evaluatorFindingSchema = z
  .object({
    /** Category the evaluator assigned, from the same taxonomy as {@link humanFindingSchema}. */
    category: findingCategory,
    /** Severity the evaluator assigned, where it assigns one. */
    severity: severityLevel.optional(),
    /** Evaluator confidence in `[0, 1]`, where it reports one. */
    confidence: z.number().min(0).max(1).optional(),
  })
  .meta({ id: "EvaluatorFinding", title: "EvaluatorFinding" });

/** @see evaluatorFindingSchema */
export type EvaluatorFinding = z.infer<typeof evaluatorFindingSchema>;

/** What an evaluator said about one case. */
export const evaluatorOutcomeSchema = z
  .object({
    /** Case this outcome reports on. */
    caseId: identifier,
    /** Whether the evaluator flagged the subject. */
    flagged: z.boolean(),
    /**
     * The defect occurrences it enumerated. Empty when not flagged, **and also empty when the
     * evaluator flagged without enumerating** (#140).
     *
     * An empty list under `flagged: true` is therefore not a contradiction and must not be
     * repaired by inventing an entry. A wrapped legacy evaluator reports that it had something to
     * say and not how much; fabricating one finding would make its report count as one defect,
     * which is the statistic this distinction exists to protect.
     */
    findings: z.array(evaluatorFindingSchema).max(256),
    /**
     * Whether site-level metrics are computable for this case (#140).
     *
     * `false` when the evaluator flagged without enumerating, or when a report could not be mapped
     * to this case's subject scope at all. Site-level precision and recall are then **unmeasurable
     * rather than zero**, and a metric that silently treated an unenumerated flag as zero findings
     * would report perfect precision for an evaluator nobody measured.
     *
     * Absent means measurable, which is what every record written before this field meant.
     */
    siteMetricsMeasurable: z.boolean().optional(),
  })
  .meta({ id: "EvaluatorOutcome", title: "EvaluatorOutcome" });

/** @see evaluatorOutcomeSchema */
export type EvaluatorOutcome = z.infer<typeof evaluatorOutcomeSchema>;

/**
 * One evaluator's outcomes over one corpus.
 *
 * This package does **not** run evaluators (contract §22 WP-10 scope). A run is produced
 * elsewhere and handed here for comparison.
 */
export const evaluatorRunSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    /** Which evaluator produced these outcomes. */
    evaluatorId: identifier,
    /** Version of the evaluator. Metrics from different versions are not comparable. */
    evaluatorVersion: identifier,
    /** Corpus the outcomes are against. */
    corpusId: identifier,
    /** The outcomes. */
    outcomes: z.array(evaluatorOutcomeSchema).max(100_000),
    /** When the run was executed. */
    executedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "EvaluatorRun",
    title: "EvaluatorRun",
    description:
      "One evaluator's outcomes over one defect corpus (architecture contract §22 WP-10). This " +
      "package consumes runs; it does not execute evaluators. ADDITIONAL CONSTRAINT NOT " +
      "EXPRESSIBLE IN JSON SCHEMA: `caseId` must be unique within `outcomes`.",
  });

/** @see evaluatorRunSchema */
export type EvaluatorRun = z.infer<typeof evaluatorRunSchema>;

/** Schema version this package stamps on records it constructs. */
export const REGRESSION_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * Validate a corpus and check the uniqueness constraint Zod cannot express.
 *
 * @throws {AldusError} `ALDUS_CORPUS_MALFORMED` or `ALDUS_CORPUS_DUPLICATE_CASE`.
 */
export function parseDefectCorpus(input: unknown): DefectCorpus {
  const result = defectCorpusSchema.safeParse(input);
  if (!result.success) {
    // Paths and issue codes only — never the received value (contract §19.2, ADR-0002).
    throw regressionError(
      RegressionErrorCodes.CORPUS_MALFORMED,
      "The defect corpus does not validate.",
      {
        category: "validation",
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        },
      },
    );
  }

  const seen = new Set<string>();
  for (const entry of result.data.cases) {
    if (seen.has(entry.caseId)) {
      throw regressionError(
        RegressionErrorCodes.CORPUS_DUPLICATE_CASE,
        `Corpus "${result.data.corpusId}" contains more than one case with id "${entry.caseId}". ` +
          "Duplicate ids would let one case be counted twice and silently reweight every metric.",
        { category: "validation", details: { corpusId: result.data.corpusId } },
      );
    }
    seen.add(entry.caseId);
  }
  return result.data;
}

/**
 * Validate an evaluator run and check uniqueness.
 *
 * @throws {AldusError} `ALDUS_CORPUS_MALFORMED` or `ALDUS_OUTCOME_DUPLICATE`.
 */
export function parseEvaluatorRun(input: unknown): EvaluatorRun {
  const result = evaluatorRunSchema.safeParse(input);
  if (!result.success) {
    throw regressionError(
      RegressionErrorCodes.CORPUS_MALFORMED,
      "The evaluator run does not validate.",
      {
        category: "validation",
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        },
      },
    );
  }

  const seen = new Set<string>();
  for (const outcome of result.data.outcomes) {
    if (seen.has(outcome.caseId)) {
      throw regressionError(
        RegressionErrorCodes.OUTCOME_DUPLICATE,
        `Evaluator run for "${result.data.evaluatorId}" reports twice on case "${outcome.caseId}".`,
        { category: "validation", details: { evaluatorId: result.data.evaluatorId } },
      );
    }
    seen.add(outcome.caseId);
  }
  return result.data;
}
