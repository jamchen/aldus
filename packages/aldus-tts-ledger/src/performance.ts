/**
 * The Performance Layer (architecture contract §14).
 *
 * §14 places a representation between approved narration and a provider request:
 *
 * ```text
 * ApprovedNarration → PerformanceScript → provider-specific mapping → exact TTS request
 * ```
 *
 * The whole point of the middle step is that it "describe[s] intent independently of provider
 * syntax" (§14.1). So nothing here names a provider, a voice, or a model, and nothing here knows
 * how any provider spells a pause. A provider adapter, supplied by an integration (§4.3), maps
 * this outward.
 *
 * §14.2 requires the *inbound* direction too: an adopter may keep authoring performance
 * instructions in whatever format it already uses, and an adapter parses that into a
 * PerformanceScript. §14.2 is explicit that "the source format SHOULD change only after the
 * structured representation has proven stable" — so a derived script is the expected case and an
 * authored one is the later possibility, which is why `origin` exists. See ADR-0012.
 */

import { z } from "zod";

import { schemaVersionPattern } from "./common.js";

/**
 * Delivery pace for a segment (contract §14.1).
 *
 * A closed set because §14.1 states it as one — unlike `intent` and `emotion`, which the contract
 * leaves as free text and which are therefore open strings here.
 */
export const PERFORMANCE_PACES = ["slow", "normal", "fast"] as const;

/** @see PERFORMANCE_PACES */
export type PerformancePace = (typeof PERFORMANCE_PACES)[number];

/** A pause the performance calls for, positioned after a piece of spoken text (contract §14.1). */
export const performancePauseSchema = z
  .object({
    /** The text this pause follows. §14.1 positions pauses by content, not by character offset. */
    after: z.string().min(1).max(2000),
    /**
     * Relative strength, not a duration.
     *
     * §14.1 declares a number and says nothing about units, deliberately: a duration would be a
     * provider-shaped instruction, and the mapping from "a firm pause here" to milliseconds
     * belongs to a provider adapter that knows how that provider behaves.
     */
    strength: z.number().min(0).max(10),
  })
  .meta({
    id: "PerformancePause",
    title: "PerformancePause",
    description:
      "A pause positioned after a piece of spoken text (architecture contract §14.1). " +
      "`strength` is relative, not a duration: turning it into milliseconds is a provider " +
      "adapter's job, because only the adapter knows how that provider behaves.",
  });

/** @see performancePauseSchema */
export type PerformancePause = z.infer<typeof performancePauseSchema>;

/**
 * One segment of performance intent (contract §14.1).
 *
 * Field list transcribed from §14.1. Everything beyond `segmentId` and `spokenText` is optional,
 * because §14.2 expects adoption to begin with plain text and acquire structure over time.
 */
export const performanceSegmentSchema = z
  .object({
    /** Identity of this segment. Stable across takes, which is what makes §15's ledger joinable. */
    segmentId: z.string().min(1).max(200),
    /**
     * Exactly what is to be spoken.
     *
     * This is the text §13.2 binds by hash before paid synthesis. Changing it voids the
     * Performance Freeze, which is the point.
     */
    spokenText: z.string().min(1).max(20_000),
    /** What the segment is trying to do. Free text; §14.1 gives no vocabulary and neither does this. */
    intent: z.string().max(500).optional(),
    /** @see PERFORMANCE_PACES */
    pace: z.enum(PERFORMANCE_PACES).optional(),
    /** Words or phrases carrying stress (contract §14.1). */
    emphasis: z.array(z.string().min(1).max(500)).max(200).optional(),
    /** Pauses the performance calls for (contract §14.1). */
    pauses: z.array(performancePauseSchema).max(200).optional(),
    /** Emotional colour. Free text, for the same reason as `intent`. */
    emotion: z.string().max(200).optional(),
    /**
     * Lexicon entries governing pronunciation in this segment (contract §14.1, §15.2).
     *
     * References, not inline substitutions: a lexicon entry is scoped and versioned (§15.2), and
     * copying its spoken form into the segment would freeze one revision of a rule that is meant
     * to be revisable.
     */
    pronunciationRefs: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .meta({
    id: "PerformanceSegment",
    title: "PerformanceSegment",
    description:
      "One segment of performance intent (architecture contract §14.1), described independently " +
      "of any provider's syntax. `intent` and `emotion` are free text because the contract gives " +
      "no vocabulary for them; `pronunciationRefs` point at scoped lexicon entries rather than " +
      "inlining a spoken form, so a revisable rule is not frozen into the script.",
  });

/** @see performanceSegmentSchema */
export type PerformanceSegment = z.infer<typeof performanceSegmentSchema>;

/**
 * Where a PerformanceScript came from (contract §14.2, §14.3; contract §25 item 6).
 *
 * §25 item 6 leaves open "whether PerformanceScript remains derived or becomes an authored
 * artifact after V1". Both are representable from the start, with `derived` as the default,
 * because that is the smaller reversible option: promoting an adopter to authoring is then a
 * change of data rather than a schema migration, and neither answer is foreclosed. ADR-0012.
 */
export const SCRIPT_ORIGINS = [
  /** Parsed from an adopter's own authoring format by an adapter (§14.2). */
  "derived",
  /** Authored directly as a PerformanceScript (§25 item 6's other outcome). */
  "authored",
  /** Proposed by a Performance Tagger (§14.3) and not yet edited by a human. */
  "tagged",
] as const;

/** @see SCRIPT_ORIGINS */
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];

/** How a derived script relates to the source it was parsed from (contract §14.2). */
export const derivationSchema = z
  .object({
    /** Identity of the authoring format the adapter parsed. An open string (§4.2). */
    sourceFormat: z.string().min(1).max(200),
    /** Digest of the exact source bytes, so a re-derivation can be shown to differ. */
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Which adapter parsed it. Opaque; Core names no adapter. */
    adapterId: z.string().min(1).max(200),
    /** Version of that adapter, so a parsing change is attributable. */
    adapterVersion: z.string().min(1).max(100).optional(),
  })
  .meta({
    id: "PerformanceScriptDerivation",
    title: "PerformanceScriptDerivation",
    description:
      "How a derived PerformanceScript relates to the authoring format it was parsed from " +
      "(architecture contract §14.2). Records the adapter and the source digest, so a change in " +
      "parsing is attributable rather than appearing as a change in the content.",
  });

/** @see derivationSchema */
export type PerformanceScriptDerivation = z.infer<typeof derivationSchema>;

/**
 * A whole performance script (contract §14.1).
 *
 * §14.3 notes a Tagger "MAY suggest performance intent, but its output MUST remain inspectable",
 * and that generated tags are subject to Performance Freeze. `origin: "tagged"` plus `humanEdits`
 * is how that stays visible: an operator can see that a machine proposed the performance and
 * whether anyone has touched it since.
 */
export const performanceScriptSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionPattern,
    /** Identity of this script. */
    scriptId: z.string().min(1).max(200),
    /** Run this script belongs to (contract §6.2). */
    runId: z.string().min(1).max(200),
    /** @see SCRIPT_ORIGINS */
    origin: z.enum(SCRIPT_ORIGINS),
    /** Present when `origin` is `derived`; absent otherwise. */
    derivation: derivationSchema.optional(),
    /** The segments, in delivery order. */
    segments: z.array(performanceSegmentSchema).min(1).max(10_000),
    /**
     * Number of segments a human has edited since the script was produced (contract §14.4).
     *
     * §14.4 requires human edits to be recorded telemetry. A count rather than a diff: the diff
     * lives in the version history of the script itself, and duplicating it here would be a
     * second copy to keep honest.
     */
    humanEditedSegmentIds: z.array(z.string().min(1).max(200)).max(10_000).optional(),
    /** When this revision of the script was produced. */
    createdAt: z.iso.datetime({ offset: true }),
  })
  .refine((script) => (script.origin === "derived") === (script.derivation !== undefined), {
    message:
      '`derivation` must be present exactly when `origin` is "derived" (architecture contract §14.2).',
    path: ["derivation"],
  })
  .meta({
    id: "PerformanceScript",
    title: "PerformanceScript",
    description:
      "Performance intent for a whole piece, described independently of provider syntax " +
      "(architecture contract §14.1). ADDITIONAL CONSTRAINT NOT EXPRESSIBLE IN JSON SCHEMA: " +
      '`derivation` is present exactly when `origin` is "derived". `origin: "tagged"` marks a ' +
      "script a Performance Tagger proposed and no human has yet edited (§14.3), which matters " +
      "because §14.3 subjects generated tags to Performance Freeze.",
  });

/** @see performanceScriptSchema */
export type PerformanceScript = z.infer<typeof performanceScriptSchema>;

/**
 * Parses an adopter's authoring format into a PerformanceScript (contract §14.2).
 *
 * Injected rather than implemented. §14.2's whole premise is that the authoring format belongs to
 * the adopter, and §4.2 keeps adopter conventions out of the runtime — so this package defines the
 * seam and an integration fills it.
 */
export interface PerformanceScriptDeriver {
  /** Identity of the authoring format this deriver understands. */
  readonly sourceFormat: string;
  /** Identity of the deriver itself, recorded on the derivation. */
  readonly adapterId: string;
  /** Version of the deriver, so a parsing change is attributable. */
  readonly adapterVersion?: string;
  /** Parse source text into segments, or throw for a caller to wrap. */
  deriveSegments(source: string): PerformanceSegment[] | Promise<PerformanceSegment[]>;
}
