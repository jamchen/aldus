/**
 * Takes: what a synthesis request actually produced, and what a human decided about it
 * (architecture contract §15, §14.4, §13.3).
 *
 * A take is one attempt at one segment. §15.1 is unambiguous about what happens to the ones
 * nobody wants:
 *
 * > Rejected paid takes SHOULD be retained with unique identity until retention policy allows
 * > cleanup.
 *
 * So there is no delete here, and no update that overwrites a take. A rejected take is evidence
 * of what was tried and why it did not work — the input to §15.1's repair strategies and to
 * WP-10's defect corpus. Superseding records the replacement without erasing the replaced, the
 * same shape the artifact registry uses for the same reason.
 */

import { actorRefSchema } from "@aldus-runtime/core";
import { z } from "zod";

import { iso8601, nonEmptyString, schemaVersionPattern, sha256Hex } from "./common.js";
import {
  asrFindingSchema,
  riskSiteSchema,
  segmentTextSchema,
  synthesisParametersSchema,
  type SynthesisParameters,
} from "./request.js";

/**
 * The repair ladder (contract §12.4, §15.1).
 *
 * §12.4: "Every repair SHOULD identify the smallest safe layer." The rungs are ordered from
 * smallest to largest, and that order is the point — an evaluator or an operator choosing a
 * repair should be able to see that regenerating one segment is a smaller act than rewriting
 * narration, and that the largest rung is escalation rather than an automatic rewrite.
 *
 * §12.4's own list, in its own order:
 *
 * > - regenerate only the affected TTS segment;
 * > - change provider mapping without rewriting content;
 * > - change PerformanceScript without altering approved claims;
 * > - revise narration and invalidate dependent approvals;
 * > - escalate to human rather than applying a risky semantic rewrite.
 */
export const REPAIR_RUNGS = [
  /** Re-synthesise the same segment unchanged (§12.4). Cheapest, and changes no approved value. */
  "regenerate_segment",
  /** Change how the segment maps onto provider parameters, leaving content untouched (§12.4). */
  "provider_mapping",
  /** Change performance intent without altering approved claims (§12.4). */
  "performance_script",
  /** Revise the narration itself (§12.4). Invalidates Content Freeze and everything downstream. */
  "narration_rewrite",
  /** Hand the decision to a person rather than applying a risky rewrite (§12.4, §13.3). */
  "escalate_human",
] as const;

/** @see REPAIR_RUNGS */
export type RepairRung = (typeof REPAIR_RUNGS)[number];

/**
 * Whether a repair at this rung changes approved spoken content.
 *
 * Only `narration_rewrite` does. §13.1 requires any content-changing edit to invalidate the
 * Content Freeze "and downstream approvals" — the gate engine performs that invalidation, derived
 * from the subject digests moving (ADR-0009). This function does not invalidate anything; it says
 * which repairs are *expected* to, so a caller can warn an operator before they take one.
 */
export function invalidatesContentFreeze(rung: RepairRung): boolean {
  return rung === "narration_rewrite";
}

/** Ordinal position on the ladder, smallest first. Useful for "prefer the smallest safe layer". */
export function repairRungOrder(rung: RepairRung): number {
  return REPAIR_RUNGS.indexOf(rung);
}

/** Why a take exists and what changed to produce it (contract §12.4, §15.1). */
export const repairSchema = z
  .object({
    /** @see REPAIR_RUNGS */
    rung: z.enum(REPAIR_RUNGS),
    /** Why this repair was chosen, for an operator reading the lineage. */
    reason: z.string().min(1).max(2000),
    /**
     * Which bound digests this repair moved.
     *
     * Recorded rather than computed: the gate engine derives invalidation from the current
     * subjects, and duplicating that logic here would give two answers to one question. This is
     * the evidence trail for *why* they moved.
     */
    changedSubjects: z.array(nonEmptyString).max(50).optional(),
    /** Who chose the repair (contract §19.2). */
    chosenBy: nonEmptyString.optional(),
  })
  .meta({
    id: "TakeRepair",
    title: "TakeRepair",
    description:
      "Why a take exists and what changed to produce it (architecture contract §12.4). Rungs are " +
      "ordered smallest to largest, because §12.4 requires a repair to identify the smallest safe " +
      "layer. Only `narration_rewrite` changes approved content and so invalidates Content Freeze " +
      "(§13.1) — but the invalidation itself is the gate engine's, derived from subject drift.",
  });

/** @see repairSchema */
export type TakeRepair = z.infer<typeof repairSchema>;

/**
 * A human's judgement on a take (contract §13.3, §15).
 *
 * §13.3: "final performance approval remains human-owned until a scoped evaluator is demonstrably
 * reliable." §15 requires the ledger to carry "human decision and reason". The reason is required
 * on a rejection and not on an acceptance — a rejection without a reason cannot become a repair
 * strategy (§15.1) or a corpus case (WP-10), whereas "this one is fine" needs no elaboration.
 */
export const TAKE_DECISIONS = ["accepted", "rejected"] as const;

/** @see TAKE_DECISIONS */
export type TakeDecisionValue = (typeof TAKE_DECISIONS)[number];

/** @see TAKE_DECISIONS */
export const takeDecisionSchema = z
  .object({
    /** @see TAKE_DECISIONS */
    decision: z.enum(TAKE_DECISIONS),
    /**
     * Who decided (contract §19.2).
     *
     * A string rather than an `ActorRef`, which is the shape `GateDecision.decidedBy` uses. The
     * difference is deliberate but it is **not** a claim that the kind goes unchecked: §13.3
     * keeps final performance approval human-owned, and `TtsLedger.decideTake` refuses a
     * non-human actor outright (`ALDUS_TTS_TAKE_ACTOR_NOT_PERMITTED`). The acting identity is
     * carried separately and lands in the §20 trace, so once a decision exists this field names a
     * human by construction.
     *
     * What is left is a redundancy rather than a gap — the record restates an identity the event
     * log already holds with its kind. Typing it would be a MAJOR schema change under ADR-0003,
     * making every stored decision unreadable, which is a large price for consistency where
     * there is no authorization hole. Tracked in #64 as an owner decision, not a defect.
     *
     * An earlier version of this comment said a check here "would give two answers". That was
     * true when nothing checked and false from the moment #64's enforcement landed — recorded
     * here because ADR-0031 is about exactly this, and a stale comment beside correct code is
     * the orientation that gets the code changed.
     */
    decidedBy: nonEmptyString,
    /**
     * The acting identity, with its kind (contract §19.2; #64).
     *
     * `decidedBy` names a human by construction — `decideTake` refuses an actor kind the ledger
     * does not permit — but it is a bare string, so the record restates an identity the event log
     * already holds *typed*. `GateDecision.decidedBy` is an `ActorRef`; a take decision beside it
     * in the same workspace was not, and that asymmetry was the whole of #64.
     *
     * Optional rather than a replacement, which is what keeps this a MINOR change: making
     * `decidedBy` an `ActorRef` would be MAJOR under ADR-0003, and `SCHEMA_VERSION` is
     * package-wide, so it would make **every** stored record of every type unreadable — including
     * append-only event logs, whose rewriting is the operation the version policy exists to make
     * visible.
     *
     * Absence is meaningful and cannot be forged: `decideTake` populates both fields
     * unconditionally, so a record carrying only the string is, by construction, one written
     * before this field existed. The era marker is a property of the write path rather than a
     * convention — there is exactly one write path, asserted below.
     */
    decidedByActor: actorRefSchema.optional(),
    /** ISO-8601 with offset. */
    decidedAt: iso8601,
    /** Why. Required for a rejection; see the type note above. */
    reason: z.string().max(4000).optional(),
    /**
     * Structured defect categories, for the regression corpus (contract §12.3, WP-10).
     *
     * Open strings: §12.3 presents its taxonomy as examples, and §4.2 keeps adopter vocabularies
     * out of the runtime.
     */
    findings: z.array(nonEmptyString).max(50).optional(),
  })
  .refine(
    (decision) => decision.decision !== "rejected" || (decision.reason ?? "").trim().length > 0,
    {
      message:
        "A rejection must carry a reason (architecture contract §15: the ledger records the human decision and reason). A rejection with no reason cannot become a repair strategy or a regression case.",
      path: ["reason"],
    },
  )
  .meta({
    id: "TakeDecision",
    title: "TakeDecision",
    description:
      "A human's judgement on a take (architecture contract §13.3, §15). ADDITIONAL CONSTRAINT " +
      "NOT EXPRESSIBLE IN JSON SCHEMA: a rejection must carry a reason. An acceptance need not — " +
      "a rejection without a reason cannot become a repair strategy (§15.1) or a corpus case, " +
      "whereas an unelaborated acceptance loses nothing.",
  });

/** @see takeDecisionSchema */
export type TakeDecision = z.infer<typeof takeDecisionSchema>;

/** How a paid take was authorized (contract §13.2, §19.3). */
export const takeAuthorizationSchema = z
  .object({
    /** The gate whose approval permitted the spend. */
    gateId: nonEmptyString,
    /** The `GateDecision.decisionId` that authorized it (contract §13.2). */
    decisionId: nonEmptyString,
    /** The spend grant drawn against (contract §19.3). */
    grantId: nonEmptyString.optional(),
    /**
     * Digest of the plan scope the authorization covered.
     *
     * Recorded on the take so a later reader can tell whether the request that was made is the
     * one that was approved, without re-deriving it from a plan that may since have been revised.
     */
    planScopeSha256: sha256Hex,
  })
  .meta({
    id: "TakeAuthorization",
    title: "TakeAuthorization",
    description:
      "How a paid take was authorized (architecture contract §13.2, §19.3). Records the gate " +
      "decision and the plan-scope digest it covered, so a reader can tell whether the request " +
      "made is the one approved.",
  });

/** @see takeAuthorizationSchema */
export type TakeAuthorization = z.infer<typeof takeAuthorizationSchema>;

/**
 * What the adapter reports it actually did, where that differs from the plan (§15; ADR-0038).
 *
 * A take's `text` and `parameters` are the **plan's**. They have to be: they are set before the
 * adapter runs, and an adapter is free to be something other than the planned provider. An adopter
 * synthesising locally recorded seven takes reading `"provider": "provider-a"` for audio that
 * provider never made — each record individually well-formed, and anyone answering "which takes
 * were paid for" from that field getting seven charges that never happened.
 *
 * Stored **beside** the planned values rather than overwriting them, so no field's meaning depends
 * on whether another field is present. Read them through {@link producedParameters} and {@link producedFinalProviderText}, and compare
 * them with {@link compareProducedToRequested}.
 *
 * Absence means the adapter did not report, which is **not** the same as "the plan was followed".
 * An adapter that never learned to report looks identical to one that had nothing to report, and
 * this record cannot tell you which. That limit is the price of the field being optional, and it
 * is stated here rather than discovered.
 */
export const producedFactsSchema = z
  .object({
    /**
     * The parameters actually used, as **one whole value** or absent.
     *
     * Never a diff against the requested ones. A partial report would mean "provider is what I
     * say, voice is whatever was planned" — reintroducing one key at a time the exact ambiguity
     * this record exists to remove.
     *
     * **Whole value, not every key.** `settings` and `seed` are optional in
     * {@link synthesisParametersSchema} and stay optional here: an adapter that ran a different
     * engine should omit settings the requested provider would have used, because copying them
     * across would assert that a setting shaped audio it never touched. The first adopter got this
     * right unprompted — their local engine's produced block carries provider, voice and model and
     * omits a hosted provider's `stability`. Reporting what you used is the rule; echoing the
     * request's shape is the thing being replaced.
     */
    parameters: synthesisParametersSchema.optional(),
    /**
     * The string actually sent to the provider (contract §15 "final provider text").
     *
     * Only this stage of {@link segmentTextSchema} is observable. The earlier stages — normalised,
     * substituted, tagged — are transformations the *planner* performed, so the plan's record of
     * them is the true one. What an adapter can know, and nothing else can, is the bytes it sent.
     *
     * Divergence here is routine and legitimate, not an incident: an adopter's local engine cannot
     * read the performance tags a hosted provider's model consumes, so their adapter strips them
     * before synthesis. The take previously claimed text carrying 36 tags the engine never
     * received.
     */
    finalProviderText: z.string().max(20_000).optional(),
    /** Why the adapter diverged, in its own words. Operator-facing, never parsed. */
    reason: z.string().min(1).max(2000).optional(),
  })
  .meta({
    id: "ProducedFacts",
    title: "ProducedFacts",
    description:
      "What a synthesis adapter reports it actually did, where that differs from the plan " +
      "(architecture contract §15). Stored beside the planned values, never overwriting them. " +
      "Absence means the adapter did not report, which is not the same as the plan having been " +
      "followed.",
  });

/** @see producedFactsSchema */
export type ProducedFacts = z.infer<typeof producedFactsSchema>;

/**
 * How the bytes entered this Run — the third of §15's three facts (#136).
 *
 * Requested, produced, and **delivered** are three facts, not two. The case that forces the third:
 * a replay adapter can deliver audio a hosted provider originally made. Its *produced* facts are
 * honestly that provider's — the bytes really were made that way — while the *delivery* is a local
 * file read that called nobody and cost nothing. A two-fact model must pick one truth to record,
 * and either choice makes a class of question unanswerable.
 *
 * Written by the gateway, never by the adapter, for `adapterId`. The gateway holds the true value
 * already, and a component that can state its own identity can state a false one — the same rule
 * as `authorizationId` on a cost record and everything in a `WorkerRequest` (ADR-0035).
 */
export const takeDeliverySchema = z
  .object({
    /** Which adapter delivered the bytes. Supplied by the gateway (§20). */
    adapterId: nonEmptyString,
    /**
     * By what means, e.g. `"synthesis"`, `"replay"`, `"import"`.
     *
     * An open string, not an enumeration. §15.1 names human-recorded replacement as a repair, so a
     * closed set defined here would be wrong on arrival — and §4.2 forbids Core naming an
     * adopter's vocabulary regardless. Absent means the adapter did not say.
     */
    mechanism: z.string().min(1).max(200).optional(),
    /**
     * Whether this delivery incurred a charge, as the adapter reports it.
     *
     * The positive evidence {@link takePaidness} needs. Absent is unknown, and unknown is not
     * free: an adapter that never learned to report is indistinguishable from one that charged
     * nothing.
     */
    incurredCharge: z.boolean().optional(),
    /** The take whose bytes this delivery replays, where it replays one (§15 lineage). */
    sourceTakeId: z.string().min(1).max(200).optional(),
    /** The artifact these bytes were imported from, where they were imported (§8.1). */
    sourceArtifactId: z.string().min(1).max(200).optional(),
  })
  .meta({
    id: "TakeDelivery",
    title: "TakeDelivery",
    description:
      "How audio bytes entered a Run — the adapter and mechanism that delivered them " +
      "(architecture contract §15). Distinct from what produced them: a replay adapter delivers " +
      "audio another provider produced.",
  });

/** @see takeDeliverySchema */
export type TakeDelivery = z.infer<typeof takeDeliverySchema>;

/**
 * One synthesis attempt at one segment (contract §15).
 *
 * The field list covers §15's requirement enumeration: segment ID; text at every stage; voice,
 * model, settings, seed; provider request ID; charged or estimated cost; output URI and SHA-256;
 * risk sites and ASR findings; human decision and reason; and regeneration lineage.
 */
export const takeRecordSchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionPattern,
    /** Identity of this take. Unique forever — §15.1 requires rejected takes to keep identity. */
    takeId: nonEmptyString,
    /** Run this take belongs to (contract §6.2). */
    runId: nonEmptyString,
    /** The plan this take was made under (contract §13.2). */
    planId: nonEmptyString,
    /** Which segment (contract §15). */
    segmentId: nonEmptyString,
    /** Which attempt at that segment, starting at 1. */
    attempt: z.number().int().min(1),
    /**
     * The text at every stage, **as planned** (contract §15).
     *
     * Not as sent. This is assigned from the synthesis plan before the adapter runs, so it cannot
     * be a record of what the adapter did with it. For the string actually sent, read
     * {@link producedFinalProviderText}.
     */
    text: segmentTextSchema,
    /**
     * Provider, voice, model, settings, seed **as planned** (contract §15, §14.4).
     *
     * Not as used, for the same reason as {@link text}: assigned before the adapter runs. Read
     * {@link producedParameters} for what actually produced the audio.
     */
    parameters: synthesisParametersSchema,
    /** The facts that produced the bytes, as reported by the adapter (§15; ADR-0038). */
    produced: producedFactsSchema.optional(),
    /** How the bytes entered this Run (§15; #136). Written by the gateway. */
    delivery: takeDeliverySchema.optional(),
    /** The provider's own request identifier, for reconciliation (contract §15). */
    providerRequestId: z.string().min(1).max(400).optional(),
    /**
     * What it cost (contract §15 "charged or estimated cost").
     *
     * A reference to a Core `CostRecord`, not a copy. §19.3 makes cost governance the gate
     * engine's and the cost ledger's business; duplicating an amount here would create a second
     * number to keep reconciled with the one budgets are actually computed from.
     */
    costRecordId: z.string().min(1).max(200).optional(),
    /** How the spend was authorized (contract §13.2). Absent for an unpaid or local take. */
    authorization: takeAuthorizationSchema.optional(),
    /**
     * Why a charge was recorded without a valid authorization (contract §13.2, §20).
     *
     * Present **only** on a take admitted through the unauthorized-charge path. Its presence is
     * the marker that §13.2 was not satisfied: the money was already spent by the time the
     * ledger heard about it, and refusing to record would have left §20's production trace
     * unable to answer "what it cost" — a charge that happened but appears nowhere.
     *
     * Recording it is not condoning it. This field carries no policy about what an operator
     * should do next; it exists so the question is answerable at all.
     */
    unauthorizedCharge: z
      .object({
        /** Why the authorization was absent or invalid, as reported by the caller. */
        reason: z.string().min(1).max(2000),
        /** The authorization that was cited and rejected, where one was cited at all. */
        rejectedAuthorizationId: z.string().min(1).max(200).optional(),
        /** Who admitted the record (contract §19.2). */
        acknowledgedBy: actorRefSchema,
        /** When it was admitted. */
        acknowledgedAt: iso8601,
      })
      .optional(),
    /**
     * The produced audio, by artifact identity (contract §15 "output URI and SHA-256").
     *
     * An `artifactId` from the artifact registry, which already holds the URI, digest, and
     * archival state. §8.1 forbids treating a path as identity, and duplicating the digest here
     * would give two places for it to disagree.
     */
    audioArtifactId: z.string().min(1).max(200).optional(),
    /** Digest of the produced audio, mirrored for joins that have no registry to hand. */
    audioSha256: sha256Hex.optional(),
    /** Risk sites observed for this take (contract §15). */
    riskSites: z.array(riskSiteSchema).max(500).optional(),
    /** ASR findings over the produced audio (contract §15). Recorded, never computed here. */
    asrFindings: z.array(asrFindingSchema).max(500).optional(),
    /** The human decision, once made (contract §13.3, §15). */
    decision: takeDecisionSchema.optional(),
    /**
     * The take this one replaces (contract §15 "fallback or regeneration lineage").
     *
     * The superseded take is never deleted (§15.1). This is a backwards pointer only, so lineage
     * is a chain rather than a graph that could disagree with itself.
     */
    supersedes: z.string().min(1).max(200).optional(),
    /** Why this take exists, when it replaces another (contract §12.4). */
    repair: repairSchema.optional(),
    /** When the take was recorded. */
    recordedAt: iso8601,
  })
  .refine((take) => take.supersedes === undefined || take.repair !== undefined, {
    message:
      "A take that supersedes another must record the repair that produced it (architecture contract §12.4: every repair identifies the smallest safe layer).",
    path: ["repair"],
  })
  .meta({
    id: "TakeRecord",
    title: "TakeRecord",
    description:
      "One synthesis attempt at one segment (architecture contract §15), carrying everything §15 " +
      "requires of a request or segment record. ADDITIONAL CONSTRAINT NOT EXPRESSIBLE IN JSON " +
      "SCHEMA: a take that supersedes another must record its repair, so the lineage says not " +
      "only that something was retried but at which layer (§12.4). Rejected takes are retained " +
      "with unique identity and are never deleted (§15.1).",
  });

/** @see takeRecordSchema */
export type TakeRecord = z.infer<typeof takeRecordSchema>;

/**
 * The parameters that produced this take's audio, or `undefined` when nothing recorded them.
 *
 * **`undefined` means unknown, never "the same as requested."** That distinction is the whole
 * decision: an adapter that never learned to report produced facts is indistinguishable from one
 * that produced exactly what was planned, and a function returning the requested parameters here
 * would state the second while establishing only the first.
 *
 * The earlier draft of this function did exactly that, falling back to `take.parameters`. It made
 * the common case read nicely and it is the reason the owner's ruling says, in as many words,
 * *never infer that observed equals requested*.
 *
 * **This is the function that answers "what made these bytes."** `take.parameters` answers "what
 * was planned", and for the adapters where the question matters the two differ — an adopter
 * synthesising locally recorded seven takes naming a hosted provider that never ran.
 */
export function producedParameters(take: TakeRecord): SynthesisParameters | undefined {
  return take.produced?.parameters;
}

/**
 * The string actually sent to the provider, or `undefined` when nothing recorded it.
 *
 * Same rule as {@link producedParameters}: absent is unknown. Note that `take.text` may carry a
 * `finalProviderText` and this still return `undefined` — the plan's intended string is not
 * evidence about what the adapter sent, which is precisely how a §13.2 comparison came to have
 * the same expression on both sides.
 */
export function producedFinalProviderText(take: TakeRecord): string | undefined {
  return take.produced?.finalProviderText;
}

/** How a take's produced facts stand against the requested ones (§15; ADR-0038). */
export type ProducedFactComparison =
  /** Nothing reported what produced the bytes. Not a match, and not a divergence. */
  | { status: "unknown" }
  /** The adapter reported, and what it reported is what was requested. */
  | { status: "matches" }
  /** The adapter reported something other than what was requested. */
  | { status: "diverged"; fields: readonly ("parameters" | "text")[] };

/**
 * Compare what produced the bytes against what was requested (§15, §13.2; ADR-0038).
 *
 * Three-valued on purpose. A boolean, or a list whose emptiness means agreement, would fold
 * *unknown* into *matches* — the single inference the ruling on #133 forbids, and the one that
 * makes a record of an unreporting adapter look like evidence of compliance.
 *
 * Derived on read, never stored. A stored comparison would be a third value to keep consistent
 * with the two it summarises, which is a defect class this repository has now hit four times.
 */
export function compareProducedToRequested(take: TakeRecord): ProducedFactComparison {
  const produced = take.produced;
  if (produced === undefined) return { status: "unknown" };
  if (produced.parameters === undefined && produced.finalProviderText === undefined) {
    return { status: "unknown" };
  }
  const fields: ("parameters" | "text")[] = [];
  if (
    produced.parameters !== undefined &&
    JSON.stringify(produced.parameters) !== JSON.stringify(take.parameters)
  ) {
    fields.push("parameters");
  }
  if (
    produced.finalProviderText !== undefined &&
    produced.finalProviderText !== take.text.finalProviderText
  ) {
    fields.push("text");
  }
  return fields.length === 0 ? { status: "matches" } : { status: "diverged", fields };
}

/** Whether a take was accepted by a human (contract §13.3). */
export function isAccepted(take: TakeRecord): boolean {
  return take.decision?.decision === "accepted";
}

/** Whether a take was rejected by a human (contract §13.3). */
export function isRejected(take: TakeRecord): boolean {
  return take.decision?.decision === "rejected";
}

/** Whether a take actually cost money, as far as anything recorded establishes (§13.2; #136). */
export type TakePaidness =
  /** Charge evidence exists: a cost record, an unauthorized charge, or the adapter saying so. */
  | "paid"
  /** The adapter reported that this delivery incurred no charge. */
  | "free"
  /** Nothing establishes either. **Not** free. */
  | "unknown";

/**
 * Whether a take cost money, derived from charge evidence (contract §13.2, §19.3; #136).
 *
 * **An authorization is not charge evidence.** It means spending was *permitted*, not that it
 * *occurred* — the distinction the owner's ruling on #133 draws, and one this function got wrong
 * until #136. An adopter's seven takes were authorised by an approved synthesis gate and then
 * synthesised locally for nothing; the previous implementation called all seven paid.
 *
 * That was the third instance of one shape in the same records: a value asserting something
 * stronger than what was established, invisible because every record is well-formed.
 *
 * Three-valued, because absence of a cost record does not establish that nothing was charged — the
 * record may simply not be written yet. `free` requires an adapter to have said so.
 */
export function takePaidness(take: TakeRecord): TakePaidness {
  if (take.costRecordId !== undefined || take.unauthorizedCharge !== undefined) return "paid";
  if (take.delivery?.incurredCharge === true) return "paid";
  if (take.delivery?.incurredCharge === false) return "free";
  return "unknown";
}

/**
 * Whether a take is known to have cost money (contract §13.2, §19.3).
 *
 * Narrower than it was, and deliberately conservative in the safe direction: only `paid` counts,
 * so `unknown` reads as false here. Callers deciding anything that costs an operator money if
 * wrong — §15.1 retention among them — should branch on {@link takePaidness} and handle `unknown`
 * explicitly rather than letting this collapse it.
 */
export function isPaid(take: TakeRecord): boolean {
  return takePaidness(take) === "paid";
}
