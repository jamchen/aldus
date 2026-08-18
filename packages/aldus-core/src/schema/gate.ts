/**
 * Human gate decisions (architecture contract §13).
 */

import { z } from "zod";
import {
  actorRefSchema,
  humanText,
  iso8601,
  nonEmptyString,
  schemaVersionString,
  sha256Hex,
} from "./common.js";

/**
 * The four outcomes of a human gate (contract §13).
 *
 * `waived` is distinct from `approved`: contract §12 distinguishes a human oracle accepting the
 * work from an operator deliberately bypassing a check, and conflating them would erase the
 * evidence that a gate was skipped.
 */
export const GATE_DECISIONS = ["approved", "rejected", "changes_requested", "waived"] as const;

/** @see GATE_DECISIONS */
export type GateDecisionValue = (typeof GATE_DECISIONS)[number];

/**
 * A durable human decision bound to exact inputs (contract §13).
 *
 * Contract §3.6: "Human review MUST create a durable `GateDecision`. A chat message saying
 * 'looks good' is not enough unless it is translated into a recorded decision tied to exact
 * inputs." `subjectHashes` is what "tied to exact inputs" means mechanically.
 *
 * Field list is transcribed verbatim from contract §13, plus `schemaVersion` and `decisionId`
 * per GitHub issue #1.
 */
export const gateDecisionSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionString,
    /**
     * Identity of this decision.
     *
     * Added beyond contract §13's literal field list: contract §6 shows one Run having many
     * GateDecisions, and without an ID two decisions on the same gate are indistinguishable —
     * which makes "when was this approved, and was it later revoked" unanswerable.
     */
    decisionId: nonEmptyString,
    /**
     * Which gate was decided, e.g. a Content Freeze (§13.1), Performance Freeze (§13.2),
     * Human Ear Gate (§13.3), or Final Release Gate (§13.4).
     *
     * An OPEN string. Contract §13 names four gates but adopters define their own show-specific
     * gates (§4.3); Core must not fix the set.
     */
    gateId: nonEmptyString,
    /** Run this decision applies to. */
    runId: nonEmptyString,
    /** The outcome. @see GATE_DECISIONS */
    decision: z.enum(GATE_DECISIONS),
    /**
     * Digests of exactly what was decided upon (contract §13).
     *
     * This is the mechanism behind contract §13.1 and §13.2: an approval binds to content
     * hashes, so any content-changing edit invalidates it rather than silently carrying a stale
     * approval forward. Contract §13.2 forbids paid synthesis without a valid hash-bound
     * authorization.
     */
    subjectHashes: z.array(sha256Hex).max(4096),
    /** Who decided (contract §19.2). */
    decidedBy: actorRefSchema,
    /** When the decision was made. */
    decidedAt: iso8601,
    /** Optional rationale. Contract §12.4 expects a reason to be recorded for a rejection. */
    comment: humanText.optional(),
    /**
     * Whether the decision is void once any `subjectHashes` input changes.
     *
     * Contract §13.1 requires this for Content Freeze and §13.2 for TTS authorization. It is a
     * required field, not an optional one, so that a writer must state the invalidation policy
     * explicitly rather than inheriting an unstated default.
     */
    expiresOnChange: z.boolean(),
  })
  .meta({
    id: "GateDecision",
    title: "GateDecision",
    description:
      "A durable human decision bound to exact inputs (architecture contract §13). Contract §3.6 " +
      "requires that human review produce one of these — a chat message saying 'looks good' is " +
      "not a decision. `subjectHashes` binds the decision to specific content so that any " +
      "content-changing edit invalidates it (§13.1) rather than carrying a stale approval " +
      "forward. `waived` is deliberately distinct from `approved`: it records that a check was " +
      "bypassed, not that it passed.",
  });

/** @see gateDecisionSchema */
export type GateDecision = z.infer<typeof gateDecisionSchema>;
