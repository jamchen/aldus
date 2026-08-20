/**
 * The synthesis injection point (architecture contract §13.2, §14, §15, ADR-0015, ADR-0016).
 *
 * Aldus never calls a provider. §4.2 keeps providers out of the runtime, §15.1 forbids Aldus from
 * silently retrying paid requests, and `@aldus-runtime/tts-ledger` deliberately has no way to make a
 * request at all. An adapter supplied by an adopter integration performs the call (§4.3).
 *
 * ADR-0015 places the *policy* on Aldus's side of that injection point: Aldus decides whether the
 * adapter may be called, and the adapter only performs what it was permitted. That decision is
 * §13.2's, and §13.2 is unforgiving — paid synthesis MUST NOT run until an operator has approved
 * the spoken-text hash, the PerformanceScript hash, the voice/model/settings, the request plan or
 * segment scope, and a maximum authorized cost, and the authorization is void the moment any of
 * those moves.
 *
 * ## Why the adapter is not simply guarded by an `if`
 *
 * A boolean checked before an unconditional call puts the guarantee in the *order of two
 * statements*. Anyone adding a second call site, an early return, or a retry loop can reach the
 * adapter without the check, and nothing fails until real money has been spent on unapproved
 * content.
 *
 * So the adapter is **not reachable at all** except as the consequence of a successful
 * authorization:
 *
 * - {@link SynthesisGateway} holds the only reference to the adapter, in a private field. Nothing
 *   on `AldusContext` or `AldusServices` exposes it.
 * - The gateway has exactly one method that reaches the adapter, and that method performs the
 *   authorization itself. There is no public "call the adapter" entry point to forget to guard.
 * - The permit handed to the adapter is registered in a `WeakSet` the gateway owns, so an adapter
 *   that wants to verify it was legitimately invoked can, and a hand-built object shaped like a
 *   permit is detectably not one.
 *
 * The permit's brand symbol is declared and never exported, so a caller cannot even name the type
 * without a cast — and the `WeakSet` makes the cast useless.
 */

import type { ActorRef, Money } from "@aldus-runtime/core";
import type { GateEngine, SpendGrant } from "@aldus-runtime/gate-engine";
import type {
  AsrFinding,
  AuthorizationOutcome,
  RiskSite,
  SegmentText,
  SpendAuthorizer,
  SynthesisParameters,
  TakeRecord,
  TtsLedger,
  TtsRequestPlan,
} from "@aldus-runtime/tts-ledger";
import { planSubjectDigests } from "@aldus-runtime/tts-ledger";

import type { SubjectsProvider } from "./context.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";

/**
 * Brand proving a permit came from {@link SynthesisGateway}.
 *
 * Declared, never exported as a value. Nothing outside this module can produce the type without
 * an explicit cast, and {@link SynthesisGateway.isPermitIssued} defeats the cast.
 */
declare const SYNTHESIS_PERMIT: unique symbol;

/**
 * Every permit any {@link SynthesisGateway} has issued in this process.
 *
 * Module-scoped rather than per-gateway, because a gateway is built per plan and an adapter has no
 * way to know which instance issued the permit it was handed. Membership still means exactly one
 * thing — this object was minted after a §13.2 authorization succeeded — and a `WeakSet` keyed on
 * the permit itself holds nothing alive.
 */
const ISSUED_PERMITS = new WeakSet<SynthesisPermit>();

/**
 * Whether a permit was minted by a {@link SynthesisGateway} after a successful authorization.
 *
 * For an adapter that wants to refuse anything it was not permitted to do, without needing a
 * reference to the gateway that called it. An object built by hand answers `false`: the type can
 * be forged with a cast, the membership cannot.
 */
export function isIssuedSynthesisPermit(permit: SynthesisPermit): boolean {
  return ISSUED_PERMITS.has(permit);
}

/**
 * Proof that §13.2's authorization held at the moment synthesis was permitted.
 *
 * Holding one is not a claim; it is the *result* of the gate engine having approved this exact
 * plan. It carries the decision it rests on so the resulting take can record which approval paid
 * for it (§19.3 `CostRecord.authorizationId`).
 */
export interface SynthesisPermit {
  readonly [SYNTHESIS_PERMIT]: true;
  readonly runId: string;
  readonly planId: string;
  /** Gate whose approval permitted this synthesis (contract §13.2). */
  readonly gateId: string;
  /** The `GateDecision` that permitted it. */
  readonly decisionId: string;
  /** The spend grant it draws against, where one applies (contract §19.3). */
  readonly grantId?: string;
  /** Digest of the plan scope the approval covered. */
  readonly planScopeSha256: string;
}

/** One segment's synthesis request, as handed to an adapter. */
export interface SynthesisRequest {
  runId: string;
  planId: string;
  segmentId: string;
  /** The text in each of §15's forms. Already substituted and tagged by the planner. */
  text: SegmentText;
  /** Provider, voice, model, and settings — all opaque to Aldus (§4.2). */
  parameters: SynthesisParameters;
}

/** What an adapter reports after performing one synthesis (contract §15). */
export interface SynthesisOutcome {
  /** Provider-side request identifier, for reconciliation (contract §15). */
  providerRequestId?: string;
  /** The produced audio, by registry artifact identity (contract §8.1). */
  audioArtifactId?: string;
  /** Digest of the produced audio (contract §15 "output URI and SHA-256"). */
  audioSha256?: string;
  /** The `CostRecord` this charge was written to (contract §19.3). */
  costRecordId?: string;
  /** What it cost, where the adapter knows before a cost record exists. */
  charged?: Money;
  /** Pronunciation risk sites observed (contract §15, §15.2). */
  riskSites?: readonly RiskSite[];
  /** ASR findings over the produced audio. Recorded, never computed by Aldus. */
  asrFindings?: readonly AsrFinding[];
  /**
   * The parameters actually used, where they differ from the plan's (§15; ADR-0038).
   *
   * An adapter is not obliged to be the planned provider. An adopter synthesising locally recorded
   * seven takes reading `"provider": "provider-a"` for audio that provider never made, because the
   * take took its parameters from the plan and the adapter had no channel to say otherwise.
   *
   * **Complete where present, never partial.** Reporting only the provider would mean "voice is
   * whatever was planned", which is the ambiguity this field exists to remove, one key at a time.
   */
  observedParameters?: SynthesisParameters;
  /**
   * The string actually sent to the provider, where it differs from the plan's (§15; ADR-0038).
   *
   * Divergence is routine and legitimate: an adopter's local engine cannot read the performance
   * tags a hosted model consumes and speaks them aloud instead, so their adapter strips them. The
   * take previously recorded text carrying 36 tags the engine never received.
   */
  observedFinalProviderText?: string;
  /** Why the adapter diverged, in its own words. Recorded verbatim, never parsed. */
  observationReason?: string;
}

/**
 * An adopter's implementation that actually performs synthesis (contract §4.3).
 *
 * Implementations live in an adopter integration, never in this repository. The `permit` argument
 * exists so an adapter can refuse to act on anything it was not permitted to do; verify it with
 * {@link SynthesisGateway.isPermitIssued}.
 */
export interface SynthesisAdapter {
  /** Opaque identity of this adapter, for trace (contract §20). */
  readonly id: string;
  /** Perform one segment's synthesis. */
  synthesise(request: SynthesisRequest, permit: SynthesisPermit): Promise<SynthesisOutcome>;
}

/** Supplies the spend grant in force for a plan (contract §13.2, §19.3). */
export type SpendGrantProvider = (
  runId: string,
  planId: string,
) => Promise<SpendGrant | undefined> | SpendGrant | undefined;

/** What {@link SynthesisGateway.synthesise} produces. */
export type SynthesisResult =
  | { permitted: true; take: TakeRecord; outcome: SynthesisOutcome; permit: SynthesisPermit }
  | { permitted: false; explanation: string };

/** Wiring for a {@link SynthesisGateway}. */
export interface SynthesisGatewayOptions {
  adapter: SynthesisAdapter;
  ledger: TtsLedger;
}

/**
 * The only path from Aldus to a synthesis provider.
 *
 * Constructing one binds an adapter that nothing else can reach. Its single acting method
 * authorizes first and calls second, in one expression, so the two cannot be separated by a later
 * edit.
 */
export class SynthesisGateway {
  readonly #adapter: SynthesisAdapter;
  readonly #ledger: TtsLedger;

  constructor(options: SynthesisGatewayOptions) {
    this.#adapter = options.adapter;
    this.#ledger = options.ledger;
  }

  /** Opaque identity of the bound adapter, for trace. The adapter itself is never exposed. */
  get adapterId(): string {
    return this.#adapter.id;
  }

  /** @see isIssuedSynthesisPermit */
  isPermitIssued(permit: SynthesisPermit): boolean {
    return isIssuedSynthesisPermit(permit);
  }

  /**
   * Authorize, then synthesise, then record (contract §13.2, §15).
   *
   * Refuses without touching the adapter when §13.2's authorization does not hold. The refusal is
   * returned rather than thrown because an operator staring at a halted production needs the
   * explanation displayed, not a stack trace (the same reasoning as ADR-0006 decision 5).
   *
   * On success the take is recorded carrying the authorization it rests on, so the charge is
   * traceable to the approval that permitted it (§19.3) — and `recordTake` independently refuses a
   * charge whose authorization does not currently hold, which means the ledger re-checks what the
   * gateway just checked rather than trusting it.
   */
  async synthesise(input: {
    plan: TtsRequestPlan;
    segmentId: string;
    episodeId: string;
    actor: ActorRef;
  }): Promise<SynthesisResult> {
    const segment = input.plan.segments.find(
      (candidate) => candidate.segmentId === input.segmentId,
    );
    if (segment === undefined) {
      throw serviceError(
        ServiceErrorCodes.INVALID_REQUEST,
        `Plan "${input.plan.planId}" has no segment "${input.segmentId}".`,
        {
          category: "validation",
          details: { planId: input.plan.planId, segmentId: input.segmentId },
        },
      );
    }

    // §13.2 is checked here, and the adapter is unreachable above this line.
    const permission = await this.#ledger.permitSynthesis(input.plan);
    if (!permission.permitted) {
      return { permitted: false, explanation: permission.explanation };
    }

    // The brand is a phantom: declared as a type, never present at runtime, following the same
    // pattern `@aldus-runtime/release` uses for operation criticality. It makes the type unnameable
    // outside this module; the runtime proof is membership of ISSUED_PERMITS, which no cast can
    // manufacture.
    const permit = {
      runId: input.plan.runId,
      planId: input.plan.planId,
      gateId: permission.authorization.gateId,
      decisionId: permission.authorization.decisionId,
      ...(permission.authorization.grantId === undefined
        ? {}
        : { grantId: permission.authorization.grantId }),
      planScopeSha256: permission.authorization.planScopeSha256,
    } as SynthesisPermit;
    ISSUED_PERMITS.add(permit);

    const outcome = await this.#adapter.synthesise(
      {
        runId: input.plan.runId,
        planId: input.plan.planId,
        segmentId: segment.segmentId,
        text: segment.text,
        parameters: input.plan.parameters,
      },
      permit,
    );

    const take = await this.#ledger.recordTake({
      runId: input.plan.runId,
      planId: input.plan.planId,
      segmentId: segment.segmentId,
      episodeId: input.episodeId,
      actor: input.actor,
      take: {
        segmentId: segment.segmentId,
        text: segment.text,
        parameters: input.plan.parameters,
        authorization: {
          gateId: permit.gateId,
          decisionId: permit.decisionId,
          ...(permit.grantId === undefined ? {} : { grantId: permit.grantId }),
          planScopeSha256: permit.planScopeSha256,
        },
        ...(outcome.providerRequestId === undefined
          ? {}
          : { providerRequestId: outcome.providerRequestId }),
        ...(outcome.costRecordId === undefined ? {} : { costRecordId: outcome.costRecordId }),
        ...(outcome.audioArtifactId === undefined
          ? {}
          : { audioArtifactId: outcome.audioArtifactId }),
        ...(outcome.audioSha256 === undefined ? {} : { audioSha256: outcome.audioSha256 }),
        ...(outcome.riskSites === undefined ? {} : { riskSites: [...outcome.riskSites] }),
        ...(outcome.asrFindings === undefined ? {} : { asrFindings: [...outcome.asrFindings] }),
        // Stored beside the plan's values, never over them (ADR-0038). The whole object is omitted
        // when the adapter reported nothing, so "did not report" stays distinguishable from
        // "reported that it matched" — the second is a claim, the first is a silence.
        ...(outcome.observedParameters === undefined &&
        outcome.observedFinalProviderText === undefined
          ? {}
          : {
              observed: {
                ...(outcome.observedParameters === undefined
                  ? {}
                  : { parameters: outcome.observedParameters }),
                ...(outcome.observedFinalProviderText === undefined
                  ? {}
                  : { finalProviderText: outcome.observedFinalProviderText }),
                ...(outcome.observationReason === undefined
                  ? {}
                  : { reason: outcome.observationReason }),
              },
            }),
      },
    });

    return { permitted: true, take, outcome, permit };
  }
}

/**
 * A {@link SpendAuthorizer} backed by the gate engine (contract §13.2, §19.3).
 *
 * Two checks, and the second is the one that matters.
 *
 * First, `GateEngine.authorizeSpend` decides whether the gate is satisfied, whether the decision
 * matches the grant, and whether the amount fits the ceiling. That is §13's machinery, consumed
 * rather than re-decided (ADR-0009).
 *
 * Second — and this is enforcement Aldus adds rather than delegates — the approved decision's
 * `subjectHashes` must actually contain every digest §13.2 requires the approval to bind for
 * *this* plan. Without it, a caller who wired `subjects` to something unrelated would get a
 * satisfied gate that had approved nothing about the plan, and §13.2's binding would exist only
 * as a naming convention. `planSubjectDigests` produces the required digests; a missing one is a
 * refusal naming which.
 */
export function gateEngineSpendAuthorizer(options: {
  engine: GateEngine;
  grants: SpendGrantProvider;
  subjects: SubjectsProvider;
  /** The plan under authorization, needed to derive what §13.2 requires bound. */
  plan: TtsRequestPlan;
  /** Recorded as the spend's purpose in a refusal message. An open string (§4.2). */
  operation?: string;
}): SpendAuthorizer {
  return {
    async authorize(query): Promise<AuthorizationOutcome> {
      const grant = await options.grants(query.runId, query.planId);
      if (grant === undefined) {
        return {
          authorized: false,
          explanation:
            `No spend grant is in force for plan "${query.planId}". Contract §13.2 requires an ` +
            "operator to have approved a maximum authorized cost before paid synthesis, so a " +
            "plan with no grant is refused rather than treated as unlimited.",
        };
      }

      const subjects = await options.subjects(query.runId);
      const result = await options.engine.authorizeSpend(
        query.runId,
        grant,
        {
          amount: query.estimatedCost ?? { amount: "0", currency: grant.maxTotal.currency },
          ...(options.operation === undefined ? {} : { operation: options.operation }),
        },
        subjects,
      );

      if (!result.authorized) return { authorized: false, explanation: result.explanation };

      const required = planSubjectDigests(options.plan);
      const approved = new Set(result.decision.subjectHashes);
      const unbound = Object.entries(required)
        .filter(([, digest]) => !approved.has(digest))
        .map(([key]) => key);

      if (unbound.length > 0) {
        return {
          authorized: false,
          explanation:
            `Gate "${result.gateId}" is approved, but its approval does not bind ` +
            `${unbound.join(", ")} for plan "${query.planId}". Contract §13.2 requires the ` +
            "authorization to bind the spoken-text hash, the PerformanceScript hash, the " +
            "voice/model/settings, and the request plan scope — an approval that binds none of " +
            "them approved nothing about this plan, so synthesis is refused.",
        };
      }

      return {
        authorized: true,
        gateId: result.gateId,
        decisionId: result.decision.decisionId,
        grantId: grant.grantId,
        planScopeSha256: query.planScopeSha256,
      };
    },
  };
}
