/**
 * The known-blind-spot registry (architecture contract §12.1, §9.3).
 *
 * §12.1 lists "known blind spots" among what evaluator promotion must consider, and §9.3 makes
 * negative knowledge first-class: "Known failed approaches, unsafe transformations, evaluator
 * blind spots, and provider limitations SHOULD be first-class pack content. Learning does not
 * mean storing only successful examples."
 *
 * A blind spot is a failure mode an evaluator is *known* not to catch. It matters to promotion
 * precisely because the corpus does not contain it — so metrics computed over the corpus are not
 * evidence against a blind spot, they are evidence that the corpus did not look. An evaluator
 * with an open blind spot in a slice should never read as promotable in that slice, however good
 * its numbers are.
 *
 * ### Relationship to Knowledge Packs
 *
 * `KnowledgePackManifest.negativeKnowledge` (WP-09) holds *resource paths* — Core indexes them
 * and never parses what is behind them (§1.2, §9.1). This registry holds the structured,
 * machine-checkable records that gate promotion. They are complementary: a pack points at the
 * prose describing a blind spot, and this registry carries the part a policy can evaluate.
 */

import { actorRefSchema } from "@aldus/core";
import { z } from "zod";

import { findingCategory, scopeDimensions, severityLevel } from "./corpus.js";
import { RegressionErrorCodes, regressionError } from "./errors.js";
import { scopeMatches, type ScopeSelector } from "./scope.js";

/** How a blind spot has been dealt with. */
export const BLIND_SPOT_STATUSES = [
  /** Demonstrated and unaddressed. Disqualifies promotion in scope. */
  "open",
  /** Addressed, with the mitigation recorded. */
  "mitigated",
  /**
   * Known, unmitigated, and deliberately tolerated.
   *
   * Distinct from `mitigated` because it is a decision, not a fix — and it must stay visible in
   * the promotion report so tolerating it is a standing choice rather than a forgotten one.
   */
  "accepted",
] as const;

/** @see BLIND_SPOT_STATUSES */
export type BlindSpotStatus = (typeof BLIND_SPOT_STATUSES)[number];

/** A failure mode an evaluator is known not to catch. */
export const blindSpotSchema = z
  .object({
    /** Identity of this record. */
    blindSpotId: z.string().min(1).max(200),
    /** Evaluator the blind spot belongs to. */
    evaluatorId: z.string().min(1).max(200),
    /** What the evaluator fails to catch. Prose, for a human reading the promotion report. */
    description: z.string().min(1).max(4000),
    /**
     * Scope the blind spot applies to.
     *
     * An empty scope means it applies everywhere. A scoped blind spot disqualifies only the
     * slices it covers — an evaluator blind to one voice's artefacts is not thereby disqualified
     * for every other voice.
     */
    scope: scopeDimensions,
    /** Category from the adopter's taxonomy, where the blind spot maps to one (§12.3). */
    category: findingCategory.optional(),
    /** Severity of what goes undetected. */
    severity: severityLevel.optional(),
    /** Current status. */
    status: z.enum(BLIND_SPOT_STATUSES),
    /**
     * Cases that demonstrate it, where the corpus contains any.
     *
     * Often empty, and that is the point: a blind spot the corpus can demonstrate is a
     * measurable false negative, while one it cannot is invisible to every metric here.
     */
    evidenceCaseIds: z.array(z.string().min(1).max(200)).max(1024),
    /** What was done about it. Required in spirit when `mitigated`; prose either way. */
    mitigation: z.string().max(4000).optional(),
    /** Who recorded it (contract §19.2). */
    recordedBy: actorRefSchema,
    /** When it was recorded. */
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "BlindSpot",
    title: "BlindSpot",
    description:
      "A failure mode an evaluator is known not to catch (architecture contract §12.1, §9.3). " +
      "Corpus metrics are not evidence against a blind spot — a blind spot is by definition " +
      "something the corpus did not sample. An `open` blind spot in scope disqualifies promotion " +
      "there regardless of metrics.",
  });

/** @see blindSpotSchema */
export type BlindSpot = z.infer<typeof blindSpotSchema>;

/**
 * An in-memory, serialisable set of blind-spot records.
 *
 * Deliberately not file-backed. Persistence is the caller's choice — these records belong
 * alongside an adopter's Knowledge Packs (§9.3), and binding the registry to one storage
 * implementation would put a storage dependency in a package that only needs to read a list.
 */
export class BlindSpotRegistry {
  readonly #records = new Map<string, BlindSpot>();

  /** Build a registry from records, validating each. */
  static from(records: readonly unknown[]): BlindSpotRegistry {
    const registry = new BlindSpotRegistry();
    for (const record of records) registry.record(record);
    return registry;
  }

  /**
   * Validate and add one record.
   *
   * @throws {AldusError} `ALDUS_BLIND_SPOT_MALFORMED` or `ALDUS_BLIND_SPOT_DUPLICATE`.
   */
  record(input: unknown): BlindSpot {
    const result = blindSpotSchema.safeParse(input);
    if (!result.success) {
      // Paths and issue codes only — never the received value (contract §19.2).
      throw regressionError(
        RegressionErrorCodes.BLIND_SPOT_MALFORMED,
        "The blind-spot record does not validate.",
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
    if (this.#records.has(result.data.blindSpotId)) {
      throw regressionError(
        RegressionErrorCodes.BLIND_SPOT_DUPLICATE,
        `A blind spot with id "${result.data.blindSpotId}" is already registered.`,
        { category: "conflict", details: { blindSpotId: result.data.blindSpotId } },
      );
    }
    this.#records.set(result.data.blindSpotId, result.data);
    return result.data;
  }

  /** Every record, in insertion order. */
  list(): BlindSpot[] {
    return [...this.#records.values()];
  }

  /** Every record for one evaluator. */
  forEvaluator(evaluatorId: string): BlindSpot[] {
    return this.list().filter((record) => record.evaluatorId === evaluatorId);
  }

  /**
   * Open blind spots for an evaluator that apply within a scope slice.
   *
   * A blind spot applies to a slice when everything it scopes itself to is either held at the
   * same value by the slice, or not held by the slice at all. The second half matters: a blind
   * spot scoped to one voice applies to the whole-corpus slice, because the whole corpus
   * includes that voice.
   */
  openFor(evaluatorId: string, selector: ScopeSelector): BlindSpot[] {
    return this.forEvaluator(evaluatorId).filter((record) => {
      if (record.status !== "open") return false;
      return Object.entries(record.scope).every(([dimension, value]) => {
        const held = selector.values[dimension];
        return held === undefined || held === value;
      });
    });
  }

  /** Blind spots demonstrated by at least one case in a corpus subset. */
  demonstratedBy(evaluatorId: string, caseIds: ReadonlySet<string>): BlindSpot[] {
    return this.forEvaluator(evaluatorId).filter((record) =>
      record.evidenceCaseIds.some((caseId) => caseIds.has(caseId)),
    );
  }

  /** Serialisable form. */
  toJSON(): BlindSpot[] {
    return this.list();
  }
}

/** True when a blind spot's own scope is satisfied by a case's scope. */
export function blindSpotCoversCase(
  record: BlindSpot,
  scope: Readonly<Record<string, string>>,
): boolean {
  return scopeMatches(scope, {
    dimensions: Object.keys(record.scope),
    values: record.scope,
  });
}
