/**
 * The TTS ledger (architecture contract §15).
 *
 * What this class is for, in one sentence: making it impossible to end up with paid audio nobody
 * can account for.
 *
 * Three properties carry that:
 *
 * - **It cannot synthesise.** There is no method that calls anything, and the package imports no
 *   network module. §15.1 forbids Aldus from silently retrying paid requests, and the strongest
 *   form of that guarantee is a component that has no way to make a request in the first place.
 *   A Worker supplied by an integration performs the call (§3.2, §4.3) and reports back here.
 * - **It cannot authorize.** §13.2 makes paid synthesis conditional on a human gate decision, and
 *   `@aldus/gate-engine` owns that. The ledger asks a {@link SpendAuthorizer}, records the answer,
 *   and refuses to record a charge that answer did not permit.
 * - **It cannot forget.** §15.1 requires rejected paid takes to be retained with unique identity.
 *   Nothing here deletes a take, and the store port has no delete to call.
 */

import type { ActorRef, AldusEvent } from "@aldus/core";
import { SCHEMA_VERSION, newEventId, newId, redact } from "@aldus/core";

import { digestText } from "./common.js";
import { TtsLedgerErrorCodes, ttsLedgerError } from "./errors.js";
import { buildLineage, type SegmentLineage } from "./lineage.js";
import { resolveLexicon, type LexiconContext, type LexiconResolution } from "./lexicon.js";
import {
  performanceScriptSchema,
  type PerformanceScript,
  type PerformanceScriptDeriver,
  type PerformanceSegment,
} from "./performance.js";
import type {
  AuthorizationOutcome,
  LedgerEventSink,
  LexiconStore,
  PlanStore,
  ScriptStore,
  SpendAuthorizer,
  TakeStore,
} from "./ports.js";
import {
  planScopeDigest,
  planSubjectDigests,
  ttsRequestPlanSchema,
  type TtsRequestPlan,
} from "./request.js";
import { takeRecordSchema, type TakeDecision, type TakeRecord, type TakeRepair } from "./take.js";

/** Wiring for a {@link TtsLedger}. */
export interface TtsLedgerOptions {
  takes: TakeStore;
  plans: PlanStore;
  scripts: ScriptStore;
  events: LedgerEventSink;
  lexicon?: LexiconStore;
  /** Consulted before a paid take may be recorded (contract §13.2). */
  authorizer?: SpendAuthorizer;
  /** Injected for deterministic tests. Defaults to the real clock. */
  now?: () => Date;
  /** Injected for deterministic tests. Defaults to freshly minted ULID-based ids. */
  newTakeId?: () => string;
}

/** What a caller reports after a Worker performed one synthesis (contract §15). */
export interface RecordTakeInput {
  runId: string;
  planId: string;
  segmentId: string;
  /** Everything §15 requires of a take, minus the fields the ledger assigns. */
  take: Omit<
    TakeRecord,
    "schemaVersion" | "takeId" | "runId" | "planId" | "attempt" | "recordedAt"
  > & {
    takeId?: string;
    attempt?: number;
    recordedAt?: string;
  };
  /** Canonical Episode identity, for the emitted event (contract §6.4). */
  episodeId: string;
  /** Who recorded it (contract §19.2). */
  actor: ActorRef;
}

/** The outcome of asking whether a plan may be synthesised (contract §13.2). */
export type SynthesisPermission =
  | { permitted: true; authorization: Extract<AuthorizationOutcome, { authorized: true }> }
  | { permitted: false; explanation: string };

/**
 * Records synthesis requests, takes, and human decisions (contract §15).
 *
 * Every mutating method emits an `AldusEvent` (§6.4: **every** state mutation emits one).
 */
export class TtsLedger {
  readonly #takes: TakeStore;
  readonly #plans: PlanStore;
  readonly #scripts: ScriptStore;
  readonly #events: LedgerEventSink;
  readonly #lexicon: LexiconStore | undefined;
  readonly #authorizer: SpendAuthorizer | undefined;
  readonly #now: () => Date;
  readonly #newTakeId: () => string;

  constructor(options: TtsLedgerOptions) {
    this.#takes = options.takes;
    this.#plans = options.plans;
    this.#scripts = options.scripts;
    this.#events = options.events;
    this.#lexicon = options.lexicon;
    this.#authorizer = options.authorizer;
    this.#now = options.now ?? (() => new Date());
    this.#newTakeId = options.newTakeId ?? (() => newId("art"));
  }

  /* ---------------------------------------------------------------------------------------
   * Performance scripts (contract §14)
   * ------------------------------------------------------------------------------------ */

  /** Record a PerformanceScript (contract §14.1). */
  async recordScript(
    script: PerformanceScript,
    episodeId: string,
    actor: ActorRef,
  ): Promise<PerformanceScript> {
    const parsed = performanceScriptSchema.parse(script);
    await this.#scripts.append(parsed.runId, parsed);
    await this.#emit(parsed.runId, episodeId, actor, "tts.script.recorded", {
      scriptId: parsed.scriptId,
      origin: parsed.origin,
      segmentCount: parsed.segments.length,
    });
    return parsed;
  }

  /**
   * Derive a PerformanceScript from an adopter's own authoring format (contract §14.2).
   *
   * §14.2 expects adoption to begin this way: an adopter keeps authoring in whatever format it
   * already uses, an adapter parses it, and "the source format SHOULD change only after the
   * structured representation has proven stable". The source digest is recorded so a later change
   * in parsing is attributable to the adapter rather than appearing as a change in the content.
   *
   * @throws {AldusError} `ALDUS_TTS_DERIVATION_FAILED` if the deriver cannot parse the source.
   */
  async deriveScript(
    deriver: PerformanceScriptDeriver,
    source: string,
    context: { runId: string; scriptId: string; episodeId: string; actor: ActorRef },
  ): Promise<PerformanceScript> {
    let segments: PerformanceSegment[];
    try {
      segments = await deriver.deriveSegments(source);
    } catch (cause) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.DERIVATION_FAILED,
        `The "${deriver.sourceFormat}" deriver could not parse the authored source into a ` +
          `PerformanceScript: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          category: "validation",
          retryable: false,
          details: { sourceFormat: deriver.sourceFormat, adapterId: deriver.adapterId },
        },
      );
    }

    if (segments.length === 0) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.DERIVATION_FAILED,
        `The "${deriver.sourceFormat}" deriver produced no segments. An empty script would pass ` +
          "silently into a request plan and synthesise nothing.",
        {
          category: "validation",
          retryable: false,
          details: { sourceFormat: deriver.sourceFormat, adapterId: deriver.adapterId },
        },
      );
    }

    const script: PerformanceScript = {
      schemaVersion: SCHEMA_VERSION,
      scriptId: context.scriptId,
      runId: context.runId,
      origin: "derived",
      derivation: {
        sourceFormat: deriver.sourceFormat,
        sourceSha256: digestText(source),
        adapterId: deriver.adapterId,
        ...(deriver.adapterVersion === undefined ? {} : { adapterVersion: deriver.adapterVersion }),
      },
      segments,
      createdAt: this.#now().toISOString(),
    };
    return this.recordScript(script, context.episodeId, context.actor);
  }

  /* ---------------------------------------------------------------------------------------
   * Request plans and authorization (contract §13.2, §15)
   * ------------------------------------------------------------------------------------ */

  /** Record a request plan, the thing an operator authorizes (contract §15). */
  async recordPlan(
    plan: TtsRequestPlan,
    episodeId: string,
    actor: ActorRef,
  ): Promise<TtsRequestPlan> {
    const parsed = ttsRequestPlanSchema.parse(plan);
    await this.#plans.append(parsed.runId, parsed);
    await this.#emit(parsed.runId, episodeId, actor, "tts.plan.recorded", {
      planId: parsed.planId,
      segmentCount: parsed.segments.length,
      // Digests, not text: an event log is durable and narration is content, not telemetry.
      planScopeSha256: planScopeDigest(parsed),
    });
    return parsed;
  }

  /**
   * Whether a plan may be synthesised (contract §13.2, §19.3).
   *
   * The **only** place this package says yes to spending money, and it says so by relaying
   * someone else's answer. §13.2 requires the operator to have approved the spoken-text hash, the
   * PerformanceScript hash, the voice/model/settings, the request plan, and a maximum authorized
   * cost — `planSubjectDigests` produces the first four and the authorizer checks all of them.
   *
   * Returns a refusal rather than throwing: a caller needs to *display* why synthesis is blocked,
   * and an operator staring at a halted production wants the explanation, not a stack trace.
   */
  async permitSynthesis(plan: TtsRequestPlan): Promise<SynthesisPermission> {
    if (this.#authorizer === undefined) {
      return {
        permitted: false,
        explanation:
          "No spend authorizer is wired, so no paid synthesis can be permitted. Contract §13.2 " +
          "requires an operator approval before paid synthesis; a ledger with nothing to ask " +
          "refuses rather than assuming consent.",
      };
    }

    const outcome = await this.#authorizer.authorize({
      runId: plan.runId,
      planId: plan.planId,
      planScopeSha256: planScopeDigest(plan),
      subjectDigests: planSubjectDigests(plan),
      ...(plan.estimatedTotal === undefined ? {} : { estimatedCost: plan.estimatedTotal }),
    });

    if (!outcome.authorized) return { permitted: false, explanation: outcome.explanation };
    return { permitted: true, authorization: outcome };
  }

  /* ---------------------------------------------------------------------------------------
   * Takes (contract §15)
   * ------------------------------------------------------------------------------------ */

  /**
   * Record what a Worker produced (contract §15).
   *
   * A **paid** take — one carrying an authorization or a cost record — is refused unless its
   * authorization is currently valid and covers this exact plan. §13.2 voids an approval when any
   * bound value moves, and a ledger that recorded a charge under a void approval would be
   * asserting that spend was authorized when it was not.
   *
   * An unpaid take (a local render, or §15.1's human-recorded replacement) needs no authorization
   * and is recorded as-is.
   *
   * @throws {AldusError} `ALDUS_TTS_UNAUTHORIZED_CHARGE` when the authorization does not hold.
   * @throws {AldusError} `ALDUS_TTS_PLAN_MISMATCH` when it holds but covers a different plan.
   */
  async recordTake(input: RecordTakeInput): Promise<TakeRecord> {
    const plan = await this.#requirePlan(input.runId, input.planId);
    const existing = await this.#takes.list(input.runId);
    const attempt =
      input.take.attempt ??
      existing.filter((take) => take.segmentId === input.segmentId).length + 1;

    const candidate: TakeRecord = takeRecordSchema.parse({
      ...input.take,
      schemaVersion: SCHEMA_VERSION,
      takeId: input.take.takeId ?? this.#newTakeId(),
      runId: input.runId,
      planId: input.planId,
      segmentId: input.segmentId,
      attempt,
      recordedAt: input.take.recordedAt ?? this.#now().toISOString(),
    });

    const paid = candidate.authorization !== undefined || candidate.costRecordId !== undefined;
    if (paid && candidate.unauthorizedCharge === undefined) {
      await this.#assertChargeAuthorized(plan, candidate);
    }

    await this.#takes.append(input.runId, candidate);
    await this.#emit(input.runId, input.episodeId, input.actor, "tts.take.recorded", {
      takeId: candidate.takeId,
      segmentId: candidate.segmentId,
      attempt: candidate.attempt,
      paid,
      ...(candidate.supersedes === undefined ? {} : { supersedes: candidate.supersedes }),
      ...(candidate.repair === undefined ? {} : { repairRung: candidate.repair.rung }),
    });
    return candidate;
  }

  /**
   * Record a charge that was incurred without a valid authorization (contract §13.2, §20).
   *
   * §13.2's enforcement point is {@link TtsLedger.permitSynthesis}, before a Worker runs. By the
   * time a take reaches the ledger the money is already gone, so {@link TtsLedger.recordTake}
   * refusing an unauthorized charge does not prevent spend — it prevents the ledger *asserting*
   * that spend was authorized when it was not.
   *
   * That leaves a worse hole if refusal is the only option: a Worker that skipped
   * `permitSynthesis` produces a real charge the ledger will not record, and §20 requires the
   * production trace to answer "what it cost". A charge that happened but appears nowhere is its
   * own harm, and a larger one than an ugly record.
   *
   * So this admits the record and marks it plainly, via
   * {@link TakeRecord.unauthorizedCharge}. It deliberately carries **no policy** about what an
   * operator does next — whether such a take may be accepted, whether it must be escalated, and
   * what it means for a budget are decisions this package does not own. It only makes the
   * question answerable.
   *
   * The emitted event uses a distinct action so an unauthorized charge is greppable in the log
   * rather than hidden among ordinary recordings.
   */
  async recordUnauthorizedCharge(
    input: RecordTakeInput & { reason: string; rejectedAuthorizationId?: string },
  ): Promise<TakeRecord> {
    const take = await this.recordTake({
      ...input,
      take: {
        ...input.take,
        unauthorizedCharge: {
          reason: input.reason,
          ...(input.rejectedAuthorizationId === undefined
            ? {}
            : { rejectedAuthorizationId: input.rejectedAuthorizationId }),
          acknowledgedBy: input.actor,
          acknowledgedAt: this.#now().toISOString(),
        },
      },
    });
    await this.#emit(input.runId, input.episodeId, input.actor, "tts.charge.unauthorized", {
      takeId: take.takeId,
      segmentId: take.segmentId,
      reason: input.reason,
      ...(input.rejectedAuthorizationId === undefined
        ? {}
        : { rejectedAuthorizationId: input.rejectedAuthorizationId }),
    });
    return take;
  }

  /**
   * Attach a human's judgement to a take (contract §13.3, §15).
   *
   * A take is decided once. §13.3 keeps final performance approval human-owned, and a decision
   * that could be overwritten would make "who approved this and when" unanswerable — the exact
   * question §20's production trace exists to answer. Changing one's mind is a **new take**
   * superseding this one, which is also what preserves the rejected take §15.1 requires kept.
   *
   * @throws {AldusError} `ALDUS_TTS_TAKE_ALREADY_DECIDED`
   */
  async decideTake(
    runId: string,
    takeId: string,
    decision: TakeDecision,
    episodeId: string,
  ): Promise<TakeRecord> {
    const takes = await this.#takes.list(runId);
    const take = takes.find((candidate) => candidate.takeId === takeId);
    if (take === undefined) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.NOT_FOUND,
        `No take "${takeId}" is recorded for run "${runId}".`,
        { category: "not_found", retryable: false, details: { runId, takeId } },
      );
    }
    if (take.decision !== undefined) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.TAKE_ALREADY_DECIDED,
        `Take "${takeId}" was already ${take.decision.decision} by ${take.decision.decidedBy}. A ` +
          "decision is not editable: record a new take superseding this one instead, which is " +
          "also what keeps the earlier take (§15.1).",
        {
          category: "conflict",
          retryable: false,
          details: { runId, takeId, existingDecision: take.decision.decision },
        },
      );
    }

    const decided: TakeRecord = { ...take, decision };
    await this.#takes.replace(runId, decided);
    await this.#emit(
      runId,
      episodeId,
      { kind: "human", id: decision.decidedBy },
      `tts.take.${decision.decision}`,
      {
        takeId,
        segmentId: take.segmentId,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.findings === undefined ? {} : { findings: decision.findings }),
      },
    );
    return decided;
  }

  /* ---------------------------------------------------------------------------------------
   * Reading (contract §15, §20)
   * ------------------------------------------------------------------------------------ */

  /** Every take recorded for a Run, including rejected ones (contract §15.1). */
  listTakes(runId: string): Promise<TakeRecord[]> {
    return this.#takes.list(runId);
  }

  /** Take lineage per segment (contract §15 "fallback or regeneration lineage"). */
  async lineage(runId: string): Promise<Map<string, SegmentLineage>> {
    return buildLineage(await this.#takes.list(runId));
  }

  /** Resolve the lexicon for a synthesis context (contract §15.2). */
  async resolveLexiconFor(runId: string, context: LexiconContext): Promise<LexiconResolution> {
    const entries = this.#lexicon === undefined ? [] : await this.#lexicon.list(runId);
    return resolveLexicon(entries, context);
  }

  /* ---------------------------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------------------------ */

  async #requirePlan(runId: string, planId: string): Promise<TtsRequestPlan> {
    const plans = await this.#plans.list(runId);
    const plan = plans.find((candidate) => candidate.planId === planId);
    if (plan === undefined) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.NOT_FOUND,
        `No request plan "${planId}" is recorded for run "${runId}". A take cannot be attributed ` +
          "to a plan the ledger never saw, and §13.2 binds the plan an approval covered.",
        { category: "not_found", retryable: false, details: { runId, planId } },
      );
    }
    return plan;
  }

  /** Refuse a paid take whose authorization does not currently hold (contract §13.2). */
  async #assertChargeAuthorized(plan: TtsRequestPlan, take: TakeRecord): Promise<void> {
    const authorization = take.authorization;
    if (authorization === undefined) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.UNAUTHORIZED_CHARGE,
        `Take "${take.takeId}" records a cost but no authorization. Contract §13.2 forbids paid ` +
          "synthesis without an operator approval, so a charge with nothing behind it cannot be " +
          "recorded as authorized spend.",
        {
          category: "policy",
          retryable: false,
          details: { takeId: take.takeId, planId: take.planId },
        },
      );
    }

    const scope = planScopeDigest(plan);
    if (authorization.planScopeSha256 !== scope) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.PLAN_MISMATCH,
        `Take "${take.takeId}" cites an authorization covering a different request. The plan has ` +
          `since changed, so decision "${authorization.decisionId}" does not authorize what was ` +
          "actually synthesised (§13.2 binds the request plan).",
        {
          category: "policy",
          retryable: false,
          details: {
            takeId: take.takeId,
            planId: plan.planId,
            authorizedScope: authorization.planScopeSha256,
            currentScope: scope,
          },
        },
      );
    }

    const permission = await this.permitSynthesis(plan);
    if (!permission.permitted) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.UNAUTHORIZED_CHARGE,
        `Take "${take.takeId}" cannot be recorded as authorized spend: ${permission.explanation}`,
        {
          category: "policy",
          retryable: false,
          details: { takeId: take.takeId, planId: plan.planId },
        },
      );
    }

    if (permission.authorization.decisionId !== authorization.decisionId) {
      throw ttsLedgerError(
        TtsLedgerErrorCodes.UNAUTHORIZED_CHARGE,
        `Take "${take.takeId}" cites decision "${authorization.decisionId}", but the decision now ` +
          `authorizing this plan is "${permission.authorization.decisionId}". An authorization ` +
          "from a superseded decision does not carry forward (§13.2).",
        {
          category: "policy",
          retryable: false,
          details: {
            takeId: take.takeId,
            citedDecisionId: authorization.decisionId,
            currentDecisionId: permission.authorization.decisionId,
          },
        },
      );
    }
  }

  async #emit(
    runId: string,
    episodeId: string,
    actor: ActorRef,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const event: AldusEvent = {
      schemaVersion: SCHEMA_VERSION,
      eventId: newEventId(),
      occurredAt: this.#now().toISOString(),
      episodeId,
      runId,
      action,
      actor,
      inputRefs: [],
      outputRefs: [],
      // §19.2: an event is durable, so a secret written here once is leaked permanently.
      details: redact(details) as Record<string, unknown>,
    };
    await this.#events.emit(event);
  }
}

/** A repair, ready to attach to the take that carries it out (contract §12.4). */
export function repairFor(rung: TakeRepair["rung"], reason: string, chosenBy?: string): TakeRepair {
  return { rung, reason, ...(chosenBy === undefined ? {} : { chosenBy }) };
}
