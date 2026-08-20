/**
 * Synthesis request plans and their bound digests (architecture contract §13.2, §15).
 *
 * §15's flow puts an explicit authorization step between an approved PerformanceScript and any
 * paid call:
 *
 * ```text
 * Approved PerformanceScript → TTS request plan and cost preview → Human authorization → TTS Worker
 * ```
 *
 * A plan is the thing an operator approves. §13.2 requires the approval to bind the spoken-text
 * hash, the PerformanceScript hash, the voice/model/settings, the request plan or segment scope,
 * and a maximum authorized cost — so a plan must be able to produce exactly those digests, and
 * changing any of them must change what the plan hashes to.
 *
 * Nothing here calls anything. A plan is a description; a Worker supplied by an integration
 * performs the call and reports back (§3.2, §4.3).
 */

import { z } from "zod";

import {
  digestJson,
  digestText,
  iso8601,
  nonEmptyString,
  schemaVersionPattern,
  sha256Hex,
} from "./common.js";

/**
 * Provider-facing synthesis parameters (contract §15, §14.4).
 *
 * Every field is an opaque caller-supplied value. Contract §4.2 states Aldus Core does not own
 * "a particular TTS voice or model", and §1.2 rules out prescribing a provider — so this package
 * never validates that a voice exists, never knows what a setting means, and never has a default.
 * A provider adapter supplied by an integration owns all of that.
 */
export const synthesisParametersSchema = z
  .object({
    /** Which provider is to be called. Opaque identity; Core names none (§4.2). */
    provider: nonEmptyString,
    /** Which voice. Opaque. */
    voice: nonEmptyString,
    /** Which model. Opaque. */
    model: nonEmptyString,
    /**
     * Provider settings, verbatim and already redacted.
     *
     * §19.2 requires secrets to be referenced rather than embedded, and a ledger record is
     * durable — an API key written here once is leaked permanently. Callers pass settings through
     * Core's `redact()` before planning. Credentials belong in a `SecretResolver` (§7), never here.
     */
    settings: z.record(z.string().min(1).max(200), z.unknown()).optional(),
    /**
     * Provider seed, where one was supplied (contract §8.1, §15).
     *
     * Recorded for trace only. §8.1: a seed "MUST NOT be treated as a reproducibility guarantee",
     * and §1.2 explicitly declines to guarantee that a seed reproduces identical audio. Nothing
     * in this package re-derives audio from a seed, and nothing should be built that does — it is
     * evidence of what was asked for, not a recipe for getting it back.
     */
    seed: z.string().min(1).max(400).optional(),
  })
  .meta({
    id: "SynthesisParameters",
    title: "SynthesisParameters",
    description:
      "Provider-facing synthesis parameters (architecture contract §15). Every field is an " +
      "opaque caller-supplied value: §4.2 keeps provider, voice, and model identities out of the " +
      "runtime. `settings` must already be redacted (§19.2). `seed` is recorded for trace only " +
      "and is never a reproducibility guarantee (§8.1).",
  });

/** @see synthesisParametersSchema */
export type SynthesisParameters = z.infer<typeof synthesisParametersSchema>;

/**
 * The text of one segment at each stage it passes through (contract §15).
 *
 * §15 requires "raw, normalized, substituted, tagged, and final provider text where applicable".
 * All but `raw` are optional because "where applicable" is the contract's own qualifier: a segment
 * that needed no substitution has no substituted form, and inventing one would assert a
 * transformation that never happened.
 *
 * Keeping every stage is what makes a pronunciation defect diagnosable. When a take mispronounces
 * a name, the question is *which* step introduced it — normalisation, a lexicon substitution, the
 * tagger, or the provider itself — and that is unanswerable from the final string alone.
 */
export const segmentTextSchema = z
  .object({
    /** The text as it arrived from approved narration, before any transformation. */
    raw: z.string().min(1).max(20_000),
    /** After normalisation: whitespace, punctuation, number and date expansion. */
    normalized: z.string().max(20_000).optional(),
    /** After lexicon substitution (contract §15.2). */
    substituted: z.string().max(20_000).optional(),
    /** After performance tags were applied (contract §14.3). */
    tagged: z.string().max(20_000).optional(),
    /**
     * The text the planner intends the provider to receive.
     *
     * **Intends, not received.** This value is assigned before any adapter runs, in a plan and in
     * the take derived from it, so it cannot be evidence of what an adapter sent. It read
     * "exactly what was sent to the provider" until ADR-0038, which made a §13.2 comparison
     * against the approved text tautological: both sides came from the plan, so the check would
     * pass and mean nothing.
     *
     * What an adapter actually sent is `TakeRecord.observed.finalProviderText`, read through
     * `effectiveFinalProviderText`. §13.2's comparison is between the approval and *that* value.
     */
    finalProviderText: z.string().max(20_000).optional(),
  })
  .meta({
    id: "SegmentText",
    title: "SegmentText",
    description:
      "One segment's text at each stage of transformation (architecture contract §15). Stages " +
      'beyond `raw` are optional because §15 says "where applicable" — a segment that needed no ' +
      "substitution has no substituted form. Retaining every stage is what makes a pronunciation " +
      "defect attributable to the step that introduced it.",
  });

/** @see segmentTextSchema */
export type SegmentText = z.infer<typeof segmentTextSchema>;

/**
 * A place in a segment where pronunciation is at risk (contract §15, §15.2).
 *
 * Annotations, not judgements: this package records that something was flagged and by what. §12
 * is emphatic that a machine pass is not semantic correctness, and whether a risk site actually
 * went wrong is a §13.3 human decision recorded on the take.
 */
export const riskSiteSchema = z
  .object({
    /** The text at risk. */
    text: nonEmptyString,
    /**
     * What kind of risk. An open string — §12.3 presents its diagnosis taxonomy as examples
     * ("pronunciation / homophone / named entity"), and §4.2 keeps adopter taxonomies out here.
     */
    kind: nonEmptyString,
    /** Which lexicon entry, if any, governs this site (contract §15.2). */
    lexiconEntryId: z.string().min(1).max(200).optional(),
    /** Why it was flagged, for an operator reading the ledger. */
    note: z.string().max(2000).optional(),
    /** What flagged it: a lint rule, an evaluator, or a person. Opaque identity. */
    detectedBy: z.string().min(1).max(200).optional(),
  })
  .meta({
    id: "RiskSite",
    title: "RiskSite",
    description:
      "A place in a segment where pronunciation is at risk (architecture contract §15, §15.2). " +
      "An annotation, not a judgement: whether the risk materialised is a human decision on the " +
      "take (§13.3). `kind` is an open string because §12.3's taxonomy is presented as examples.",
  });

/** @see riskSiteSchema */
export type RiskSite = z.infer<typeof riskSiteSchema>;

/**
 * A finding from automatic speech recognition over produced audio (contract §15).
 *
 * §15 requires "risk sites and ASR findings" on a record. This package **records** findings; it
 * does not compute them. Running ASR is a Worker's job (§3.2), and the finding's `confidence` is
 * carried precisely so nobody mistakes it for a verdict — §12 forbids presenting a machine pass
 * as semantic correctness, and an ASR transcript disagreeing with the script is evidence for a
 * human, not a rejection.
 */
export const asrFindingSchema = z
  .object({
    /** What the recogniser heard. */
    heard: z.string().max(20_000),
    /** What the text said it should hear. */
    expected: z.string().max(20_000).optional(),
    /** Recogniser confidence, where it reports one. */
    confidence: z.number().min(0).max(1).optional(),
    /** Which recogniser produced this. Opaque identity; Core names no service (§4.2). */
    recognizer: z.string().min(1).max(200).optional(),
    /** Offset into the audio, in seconds. */
    atSeconds: z.number().min(0).optional(),
  })
  .meta({
    id: "AsrFinding",
    title: "AsrFinding",
    description:
      "A finding from automatic speech recognition over produced audio (architecture contract " +
      "§15). Recorded, never computed here. It is evidence for a human ear decision (§13.3), not " +
      "a verdict — §12 forbids presenting a machine pass as semantic correctness.",
  });

/** @see asrFindingSchema */
export type AsrFinding = z.infer<typeof asrFindingSchema>;

/** One segment as it appears in a request plan (contract §15). */
export const plannedSegmentSchema = z
  .object({
    /** Matches `PerformanceSegment.segmentId`, which is what joins the plan to the script. */
    segmentId: nonEmptyString,
    /** The text at every stage it has reached by planning time (contract §15). */
    text: segmentTextSchema,
    /** Pronunciation risk sites known before synthesis (contract §15). */
    riskSites: z.array(riskSiteSchema).max(500).optional(),
    /** Estimated cost for this segment alone, where the provider allows a preview (§19.3). */
    estimatedCost: z
      .object({
        amount: z.string().regex(/^-?\d+(\.\d+)?$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .optional(),
  })
  .meta({
    id: "PlannedSegment",
    title: "PlannedSegment",
    description:
      "One segment as it appears in a synthesis request plan (architecture contract §15).",
  });

/** @see plannedSegmentSchema */
export type PlannedSegment = z.infer<typeof plannedSegmentSchema>;

/**
 * A planned synthesis request, and the thing §13.2 binds (contract §15).
 *
 * §15's diagram makes the plan the input to human authorization, and §13.2 lists what that
 * authorization must bind. {@link planSubjectDigests} produces exactly those digests.
 */
export const ttsRequestPlanSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionPattern,
    /** Identity of this plan. */
    planId: nonEmptyString,
    /** Run this plan belongs to (contract §6.2). */
    runId: nonEmptyString,
    /** The PerformanceScript this plan was built from (contract §13.2 binds its hash). */
    scriptId: nonEmptyString,
    /** Digest of that script at planning time (contract §13.2). */
    scriptSha256: sha256Hex,
    /** Provider, voice, model, settings, seed (contract §13.2 binds these). */
    parameters: synthesisParametersSchema,
    /** The segments to synthesise, in order (contract §13.2 binds "request plan or segment scope"). */
    segments: z.array(plannedSegmentSchema).min(1).max(10_000),
    /** Total estimated cost, where a preview is possible (contract §19.3). */
    estimatedTotal: z
      .object({
        amount: z.string().regex(/^-?\d+(\.\d+)?$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .optional(),
    /** When the plan was built. */
    createdAt: iso8601,
  })
  .meta({
    id: "TtsRequestPlan",
    title: "TtsRequestPlan",
    description:
      "A planned synthesis request: what an operator authorizes before any paid call " +
      "(architecture contract §15, §13.2). A description only — nothing in this package performs " +
      "synthesis. The digests §13.2 requires an approval to bind are derived from it by " +
      "`planSubjectDigests`.",
  });

/** @see ttsRequestPlanSchema */
export type TtsRequestPlan = z.infer<typeof ttsRequestPlanSchema>;

/**
 * The subject keys a Performance Freeze binds (contract §13.2).
 *
 * §13.2 enumerates what paid synthesis requires the operator to have approved. These are the
 * conventional keys for those subjects; a gate definition may bind them under other names (§4.3),
 * but a shared default means the common case needs no configuration — the same reasoning
 * `SPEND_LIMIT_SUBJECT_KEY` follows in the gate engine.
 */
export const PERFORMANCE_FREEZE_SUBJECT_KEYS = {
  /** §13.2 "spoken-text hash". */
  spokenText: "spokenText",
  /** §13.2 "PerformanceScript hash". */
  performanceScript: "performanceScript",
  /** §13.2 "voice, model, and relevant settings". */
  synthesisParameters: "synthesisParameters",
  /** §13.2 "request plan or segment scope". */
  requestPlan: "requestPlan",
} as const;

/**
 * Digest of the concatenated spoken text a plan will synthesise (contract §13.2).
 *
 * Segment order is included, because reordering narration changes what a listener hears even when
 * every individual segment is untouched.
 */
export function planSpokenTextDigest(plan: TtsRequestPlan): string {
  return digestText(plan.segments.map((segment) => segment.text.raw).join("\u0000"));
}

/**
 * Digest of the plan itself: parameters and segment scope (contract §13.2).
 *
 * Deliberately excludes `planId` and `createdAt`. Rebuilding an identical plan should not read as
 * the operator having approved something different — the same reasoning `grantLimitsDigest`
 * follows in the gate engine — and a timestamp that voided an approval would make re-planning
 * after a restart require re-approval for no reason.
 *
 * Estimated costs are also excluded: the ceiling is bound separately by the spend grant, and a
 * provider revising its estimate must not silently void a Performance Freeze.
 */
export function planScopeDigest(plan: TtsRequestPlan): string {
  return digestJson({
    scriptId: plan.scriptId,
    scriptSha256: plan.scriptSha256,
    parameters: plan.parameters,
    segments: plan.segments.map((segment) => ({
      segmentId: segment.segmentId,
      text: segment.text,
      riskSites: segment.riskSites ?? null,
    })),
  });
}

/** Digest of the synthesis parameters alone (contract §13.2 "voice, model, and relevant settings"). */
export function parametersDigest(parameters: SynthesisParameters): string {
  return digestJson(parameters);
}

/**
 * Every digest §13.2 requires a Performance Freeze to bind, keyed for a gate definition.
 *
 * Hand this to the gate engine as the gate's subjects. If any of the four moves, the engine's
 * drift detection voids the authorization — which is exactly what §13.2 asks for, and it happens
 * without this package knowing anything about how gates work.
 */
export function planSubjectDigests(plan: TtsRequestPlan): Record<string, string> {
  return {
    [PERFORMANCE_FREEZE_SUBJECT_KEYS.spokenText]: planSpokenTextDigest(plan),
    [PERFORMANCE_FREEZE_SUBJECT_KEYS.performanceScript]: plan.scriptSha256,
    [PERFORMANCE_FREEZE_SUBJECT_KEYS.synthesisParameters]: parametersDigest(plan.parameters),
    [PERFORMANCE_FREEZE_SUBJECT_KEYS.requestPlan]: planScopeDigest(plan),
  };
}
