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

import {
  newId,
  SCHEMA_VERSION,
  type ActorRef,
  type CostObservation,
  type CostRecord,
  type Money,
} from "@aldus-runtime/core";
import { formatMoney, isPositiveMoney } from "@aldus-runtime/gate-engine";
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
import type { CostRecordStore } from "./cost-store.js";
import type { SpendService } from "./spend-service.js";
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
  producedParameters?: SynthesisParameters;
  /**
   * The string actually sent to the provider, where it differs from the plan's (§15; ADR-0038).
   *
   * Divergence is routine and legitimate: an adopter's local engine cannot read the performance
   * tags a hosted model consumes and speaks them aloud instead, so their adapter strips them. The
   * take previously recorded text carrying 36 tags the engine never received.
   */
  producedFinalProviderText?: string;
  /** Why the adapter diverged, in its own words. Recorded verbatim, never parsed. */
  productionReason?: string;
  /**
   * What the provider billed, as facts the adapter observed (§19.3; #160).
   *
   * The synthesis counterpart of `AgentResult.costs`. Before this, `SynthesisGateway` copied an
   * adapter-supplied `costRecordId` and nothing else — so an adapter that knew what it was charged
   * had no way to say so, and an approved ceiling had nothing to consume. Credits stay in
   * {@link CostObservation.quantity}; they are never converted into an invented currency.
   *
   * The adapter reports billing facts. The Runtime supplies `costId`, Run, Stage, attempt,
   * `authorizationId`, `takeId` and later `reservationId` — an adapter that could mint those could
   * name an approval that did not authorize it.
   */
  costs?: readonly CostObservation[];
  /**
   * How the bytes entered the Run, e.g. `"synthesis"`, `"replay"`, `"import"` (§15; #136).
   *
   * Distinct from what produced them. A replay adapter delivers audio another provider produced:
   * its produced facts are honestly that provider's, and its delivery called nobody.
   */
  mechanism?: string;
  /** The take whose bytes this replays, where it replays one (§15 lineage; #136). */
  sourceTakeId?: string;
  /** The artifact these bytes were imported from, where they were (§8.1; #136). */
  sourceArtifactId?: string;
  /**
   * Whether this delivery incurred a charge (§13.2, §19.3; #136).
   *
   * Where omitted it is derived from {@link charged}. Absent from both means unknown, which is
   * **not** free — see `takePaidness`.
   *
   * **This answers "did this delivery charge?" and nothing else.** It is not
   * {@link SynthesisAdapterCapabilities.incursCharge}, which answers the other question — *can
   * this adapter charge at all?* — before any dispatch and only for the spend expectation. The two
   * are read by different code and neither is derived from the other: declaring `incursCharge:
   * false` does not make a delivery free, and reporting `incurredCharge: false` does not make an
   * adapter free (#203).
   *
   * Worked example, the replay adapter. It declares `incursCharge: false`, because replaying
   * stored bytes calls no provider. Its delivery **omits** `incurredCharge`, so the take's
   * `takePaidness` is `unknown` — and that is the correct value, not a gap: the bytes were
   * purchased once, by the take being replayed, and are being delivered again for nothing. `paid`
   * would charge them twice; `free` would say they were never bought. `unknown` is the only one of
   * the three that is not a false statement about purchased bytes.
   */
  incurredCharge?: boolean;
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
  /**
   * Version of this adapter, resolved exactly (§20; ADR-0044).
   *
   * Optional for compatibility, and recorded as `"unknown"` when absent — which reads correctly as
   * *nobody said*, not as a version. A reservation records what was true of the execution it
   * covers, and an unnamed version is weaker evidence than a named one rather than equivalent.
   */
  readonly version?: string;
  /**
   * What this adapter may do, declared before it is called (#136).
   *
   * Optional, and an adapter that omits it is treated as declaring nothing — which is the safe
   * reading, not a permissive one: nothing it might do is assumed absent.
   *
   * Exists so §13.2's "rejected **before** the provider call" is reachable at all. A divergence
   * between authorized and produced facts is only visible *after* the call, by which time a paid
   * provider has been billed and a refusal is a post-mortem. A declaration is the only thing
   * available beforehand.
   */
  capabilities?(): Promise<SynthesisAdapterCapabilities> | SynthesisAdapterCapabilities;
  /** Perform one segment's synthesis. */
  synthesise(request: SynthesisRequest, permit: SynthesisPermit): Promise<SynthesisOutcome>;
}

/** What an adapter declares about itself before being called (#136). */
export interface SynthesisAdapterCapabilities {
  /** How this adapter delivers bytes, e.g. `"synthesis"`, `"replay"`, `"import"`. Open (§4.2). */
  mechanism?: string;
  /**
   * Whether this adapter may send something other than the text or parameters it was handed.
   *
   * Declaring `true` is not a licence — it is what makes a **paid** execution refusable before the
   * provider is called. An adopter's local engine cannot read the performance tags a hosted model
   * consumes, so it strips them; that is legitimate for a free local render and is exactly what
   * §13.2 forbids for a paid one, where the operator approved text that would not be what was
   * sent.
   */
  maySubstitute?: boolean;
  /**
   * Whether this adapter incurs a provider charge at all.
   *
   * `false` makes the synthesis path able to say `{ kind: "free" }`. Without it the expectation was
   * `unestimated` whenever no estimate was present, so **a genuinely free adapter was
   * indistinguishable from a paid one nobody estimated** — and a grant that does not permit
   * unestimated execution refused it. That is the exact ambiguity `CostExpectation`'s closed shape
   * was introduced to remove, surviving in the one path where the free case is real (ADR-0044).
   *
   * Declared by the adapter rather than inferred from a zero estimate, because a zero estimate is
   * a *prediction* that nothing will be charged and this is a *statement* that nothing can be. An
   * adopter reduced to writing `estimatedCost: 0` for a local engine said so themselves: it is
   * honest and it is not the same statement.
   *
   * Absent means unknown, and is treated as before.
   *
   * **This answers "can this adapter charge at all?" and nothing else.** It is read once, when the
   * spend expectation for a segment is formed, and feeds only that expectation. It is not
   * {@link SynthesisOutcome.incurredCharge}, which answers the other question — *did this
   * delivery charge?* — after the fact and per delivery, and is the only field `takePaidness`
   * reads. Declaring `incursCharge: false` makes the *expectation* `{ kind: "free" }`; it does not
   * make any *take* free, and nothing derives one field from the other (#203).
   *
   * Worked example, the replay adapter. It may declare `incursCharge: false` safely, because
   * replaying stored bytes calls no provider. That declaration says nothing about its deliveries:
   * with `incurredCharge` omitted on each, the replayed take's `takePaidness` is `unknown`, which
   * is the correct value — the bytes were purchased once, by the take being replayed, and `unknown`
   * is the only one of `paid` / `free` / `unknown` that is not a false statement about them.
   */
  incursCharge?: boolean;
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
  /**
   * Reserves authorization before dispatch and settles it after (ADR-0044; #155 step 4).
   *
   * Optional so an existing composition keeps working, and the gateway says which protection is in
   * force rather than implying the stronger one: without it, spend is enforced only *between*
   * durably recorded executions, which is not concurrency-safe.
   */
  spend?: SpendService;
  /**
   * Supplies the grant a reservation draws on (§13.2; #155 step 4).
   *
   * The permit names the *decision*; a reservation consumes a *pool*, and #158 established those
   * are different identities. So the gateway resolves the grant itself rather than reconstructing
   * one from the permit, which would make one decision mean one budget pool by accident.
   */
  grants?: SpendGrantProvider;
  /**
   * Where attributed cost records are written (§19.3; #160).
   *
   * The same port `AgentExecutionService` uses, injected here rather than duplicated: a second
   * definition of where money is recorded is two answers to one question.
   *
   * Optional so an existing composition keeps working; when absent, a reported observation is
   * refused rather than dropped, because silently discarding a charge is the defect this closes.
   */
  costs?: CostRecordStore;
  now?: () => Date;
  newTakeId?: () => string;
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
  readonly #costs: CostRecordStore | undefined;
  readonly #spend: SpendService | undefined;
  readonly #grants: SpendGrantProvider | undefined;
  readonly #now: () => Date;
  readonly #newTakeId: () => string;

  constructor(options: SynthesisGatewayOptions) {
    this.#adapter = options.adapter;
    this.#ledger = options.ledger;
    this.#costs = options.costs;
    this.#spend = options.spend;
    this.#grants = options.grants;
    this.#now = options.now ?? (() => new Date());
    // Matches `TtsLedger`'s own minting so a preallocated id is indistinguishable from one the
    // ledger would have produced. That the ledger uses the *artifact* prefix for a take is odd and
    // is recorded separately rather than changed here — altering it would reshape existing ids.
    this.#newTakeId = options.newTakeId ?? (() => newId("art"));
  }

  /** Opaque identity of the bound adapter, for trace. The adapter itself is never exposed. */
  get adapterId(): string {
    return this.#adapter.id;
  }

  /**
   * Turn the adapter's billing facts into attributed cost records (§19.3; #160).
   *
   * Ordering is the contract: the records are durable **before** the take is recorded. A take
   * recorded first would say the work settled while the charge that paid for it is absent, and the
   * failure direction that matters is under-reporting spend.
   *
   * Ids are derived from the preallocated take, so a retry re-appends the same identities instead
   * of minting new ones and counting the charge twice.
   */
  async #recordCosts(
    input: { plan: TtsRequestPlan; segmentId: string },
    takeId: string,
    outcome: SynthesisOutcome,
    permit: SynthesisPermit,
  ): Promise<string[]> {
    const observations = outcome.costs ?? [];
    if (observations.length === 0) return [];

    const costs = this.#costs;
    if (costs === undefined) {
      // Refused rather than dropped. An adapter that reported a charge into a composition with
      // nowhere to record it is exactly the state #160 reported, and silence would reproduce it.
      throw serviceError(
        ServiceErrorCodes.INVALID_REQUEST,
        `The synthesis adapter reported ${observations.length} billing observation(s) and this ` +
          "composition wired no cost record store, so the charge would be discarded. Supply " +
          "`costs` when constructing the gateway (§19.3).",
        {
          category: "validation",
          retryable: false,
          details: { runId: input.plan.runId, segmentId: input.segmentId },
        },
      );
    }

    const recordedAt = this.#now().toISOString();
    const written: string[] = [];
    for (const [index, observation] of observations.entries()) {
      const costId = `${takeId}:cost:${index}`;
      await costs.append(input.plan.runId, {
        ...observation,
        schemaVersion: SCHEMA_VERSION,
        costId,
        runId: input.plan.runId,
        takeId,
        // The runtime's, from the decision that authorized dispatch. Never the adapter's.
        authorizationId: permit.decisionId,
        recordedAt,
      });
      written.push(costId);
    }
    return written;
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

    // §13.2, before the provider call (#136).
    //
    // A divergence between what was authorized and what was produced is only visible *after* the
    // call, by which time a paid provider has been billed — so a refusal there is a post-mortem,
    // not a refusal. What is available beforehand is the adapter's own declaration, and an adapter
    // that declares it may substitute is refused when the execution is expected to be paid.
    //
    // Free divergence is untouched. An adopter's local engine cannot read the performance tags a
    // hosted model consumes and speaks them aloud instead, so their adapter strips them; that is
    // legitimate, costs nothing, and is recorded rather than refused (ADR-0039).
    const declared = await this.#adapter.capabilities?.();
    const expectedPaid =
      segment.estimatedCost !== undefined && isPositiveMoney(segment.estimatedCost);
    if (declared?.maySubstitute === true && expectedPaid) {
      return {
        permitted: false,
        explanation:
          `Adapter "${this.#adapter.id}" declares it may send something other than the text or ` +
          `parameters it is handed, and segment "${input.segmentId}" is expected to be paid ` +
          `(${formatMoney(segment.estimatedCost as Money)}). §13.2 binds an operator's approval ` +
          "to what is actually sent, so a paid execution that may diverge from it needs a newly " +
          "authorized plan rather than a permit issued against the old one. A free render by the " +
          "same adapter is unaffected.",
      };
    }

    // Reserved before the effect (ADR-0044; #155 step 4). The permit established that an operator
    // approved this plan; the reservation commits the headroom, which is what stops two
    // concurrent segments from both spending the same remaining authorization.
    //
    // The effect key is the segment's own identity: retrying one segment resolves to one
    // reservation rather than committing authorization twice (ADR-0043).
    const grant = await this.#grants?.(input.plan.runId, input.plan.planId);
    const reserveOutcome = await this.#spend?.reserve({
      grant,
      operation: "tts.synthesize",
      runId: input.plan.runId,
      stageId: input.plan.planId,
      attemptId: segment.segmentId,
      // Plan, segment **and attempt**. A retry of one dispatch must resolve to one reservation;
      // a *regeneration* of a rejected take is a different paid effect that charges again, and a
      // key without the attempt would make the second one resolve to the first's settled
      // reservation and refuse (ADR-0043).
      effectKey: `${input.plan.planId}:${segment.segmentId}:${
        (await this.#ledger.listTakes(input.plan.runId)).filter(
          (take) => take.segmentId === segment.segmentId,
        ).length + 1
      }`,
      // Three arms, because the free case is real here and absence used to swallow it.
      expectation:
        declared?.incursCharge === false
          ? { kind: "free" }
          : segment.estimatedCost === undefined
            ? { kind: "unestimated" }
            : { kind: "estimated", amount: segment.estimatedCost },
    });
    if (reserveOutcome?.reserved === false && reserveOutcome.reason === "refused") {
      return { permitted: false, explanation: reserveOutcome.explanation };
    }
    let reservation =
      reserveOutcome !== undefined && reserveOutcome.reserved
        ? reserveOutcome.reservation
        : undefined;

    if (reservation !== undefined && this.#spend !== undefined) {
      // Before the provider call, so the window in which dispatch may have begun is visible.
      reservation = await this.#spend.prepareDispatch(reservation, {
        backendId: this.#adapter.id,
        backendVersion: this.#adapter.version ?? "unknown",
        // A synthesis adapter has no declared ceiling-enforcement capability, so the honest answer
        // is that the Runtime could only enforce *between* executions (#107, ADR-0030).
        ceilingEnforced: false,
      });
    }

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

    // Charge evidence, from whichever channel the adapter used. `charged` existed and nothing read
    // it — a fake adapter has been reporting a per-request amount since the composed stack was
    // written and the take dropped it, which is why paidness was being read off the authorization
    // instead (#136).
    const incurredCharge =
      outcome.incurredCharge ??
      (outcome.charged === undefined ? undefined : isPositiveMoney(outcome.charged));
    const mechanism = outcome.mechanism ?? declared?.mechanism;

    // A **paid** execution that produced something other than what was authorized (§13.2; #136).
    //
    // The pre-call declaration above is the intended defence; this is what catches an adapter that
    // did not declare. The money is already gone by the time we know, so refusing to record would
    // only make the charge invisible — §20 requires the trace to answer "what it cost". What the
    // record must not do is claim the authorization covered it, and the unauthorized-charge path
    // is precisely the shape that says so.
    const diverged =
      (outcome.producedParameters !== undefined &&
        JSON.stringify(outcome.producedParameters) !== JSON.stringify(input.plan.parameters)) ||
      (outcome.producedFinalProviderText !== undefined &&
        outcome.producedFinalProviderText !== segment.text.finalProviderText);

    // Preallocated **before** the costs are written, so `CostRecord.takeId` is knowable at the
    // moment a charge is recorded rather than only after the take exists (#160). And the costs are
    // durable before the take is recorded: a take recorded first would say the work settled while
    // the charge that paid for it is absent.
    const takeId = this.#newTakeId();

    // **One writer for the charge.** Where a reservation exists, settlement writes the cost
    // records and the gateway does not: two writers produced two records for one charge, under
    // different id schemes, which is double-counted spend wearing a lineage improvement.
    //
    // Settlement's ids are derived from the reservation, which is the stronger property — they are
    // stable across a settlement retry, so a storage conflict cannot duplicate the charge.
    let costIds: string[];
    if (reservation !== undefined && this.#spend !== undefined) {
      if (outcome.providerRequestId !== undefined) {
        reservation = await this.#spend.identifyDispatch(reservation, outcome.providerRequestId);
      }
      const observations = outcome.costs ?? [];
      if (observations.length > 0) {
        // Costs durable first, then the reservation stops consuming authorization (ADR-0044).
        const settled = await this.#spend.settle(reservation, observations, {
          authorizationId: permit.decisionId,
          takeId,
        });
        costIds = settled.costs.map((record) => record.costId);
      } else if (incurredCharge === false) {
        // **Declared free is not silence.** An adapter that returns `incurredCharge: false` — or a
        // zero `charged` — has said what happened; it simply had no cost record to hand over.
        // Reading that as "reported nothing" left one unresolved charge of unknown size standing
        // against the grant, which made `remaining` indeterminate and refused **every later
        // segment**. Measured by an adopter: a local synthesis adapter could produce exactly one
        // take per grant, which made the free rehearsal path unusable past its first segment.
        //
        // The truthful settlement is a `free` cost record. It is not an invented amount: the
        // adapter stated it, `isUncharged` counts `free` as consuming nothing, and the reservation
        // releases rather than committing authorization nobody spent.
        const settled = await this.#spend.settle(
          reservation,
          [
            {
              provider: this.#adapter.id,
              operation: "tts.synthesize",
              actual: { amount: "0", currency: reservation.reserved.currency },
              billingStatus: "free",
              ...(outcome.providerRequestId === undefined
                ? {}
                : { providerRequestId: outcome.providerRequestId }),
            },
          ],
          { authorizationId: permit.decisionId, takeId },
        );
        costIds = settled.costs.map((record) => record.costId);
      } else {
        // Dispatched and said **nothing** about billing. That is uncertainty, not zero: the
        // reservation stays committed and the effect non-retryable until it is reconciled. The arm
        // above is what keeps a declaration from arriving here as silence.
        await this.#spend.markUnknown(reservation);
        costIds = [];
      }
    } else {
      costIds = await this.#recordCosts(input, takeId, outcome, permit);
    }

    const recordInput = {
      runId: input.plan.runId,
      planId: input.plan.planId,
      segmentId: segment.segmentId,
      episodeId: input.episodeId,
      actor: input.actor,
      take: {
        takeId,
        segmentId: segment.segmentId,
        text: segment.text,
        parameters: input.plan.parameters,
        ...(costIds.length > 0 ? { costIds } : {}),
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
        // The third fact (§15; #136). Always written, because the gateway always knows which
        // adapter it called — and an adapter that could state its own identity could state a
        // false one, so this value is never taken from the outcome.
        delivery: {
          adapterId: this.#adapter.id,
          ...(mechanism === undefined ? {} : { mechanism }),
          ...(incurredCharge === undefined ? {} : { incurredCharge }),
          ...(outcome.sourceTakeId === undefined ? {} : { sourceTakeId: outcome.sourceTakeId }),
          ...(outcome.sourceArtifactId === undefined
            ? {}
            : { sourceArtifactId: outcome.sourceArtifactId }),
        },
        ...(outcome.producedParameters === undefined &&
        outcome.producedFinalProviderText === undefined
          ? {}
          : {
              produced: {
                ...(outcome.producedParameters === undefined
                  ? {}
                  : { parameters: outcome.producedParameters }),
                ...(outcome.producedFinalProviderText === undefined
                  ? {}
                  : { finalProviderText: outcome.producedFinalProviderText }),
                ...(outcome.productionReason === undefined
                  ? {}
                  : { reason: outcome.productionReason }),
              },
            }),
      },
    };

    const take =
      diverged && incurredCharge === true
        ? await this.#ledger.recordUnauthorizedCharge({
            ...recordInput,
            reason:
              `Adapter "${this.#adapter.id}" charged for this segment and reported producing ` +
              "something other than what was authorized. §13.2 binds an approval to what is " +
              "actually sent, so this charge is recorded without claiming the approval covered " +
              "it. A newly authorized plan is required before repeating it.",
            rejectedAuthorizationId: permit.decisionId,
          })
        : await this.#ledger.recordTake(recordInput);

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
  /**
   * Read when a query excludes cost records (#160).
   *
   * Only consulted for an exclusion: an ordinary pre-dispatch check lets the gate engine read the
   * ledger itself, and re-reading it here would be a second answer to one question.
   */
  costs?: { list(runId: string): Promise<CostRecord[]> };
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
      // A charge being *recorded* is excluded from the availability it is checked against (#160).
      // Without this, an unknown-money charge blocks the recording of its own take: the charge is
      // durable before the take is written, so including it makes the guard refuse the fact that
      // triggered it, leaving the money recorded and nothing attributing it.
      const excluded = new Set(query.excludeCostIds ?? []);
      const costs =
        excluded.size === 0
          ? undefined
          : (await options.costs?.list(query.runId))?.filter(
              (record) => !excluded.has(record.costId),
            );
      const result = await options.engine.authorizeSpend(
        query.runId,
        grant,
        {
          amount: query.estimatedCost ?? { amount: "0", currency: grant.maxTotal.currency },
          ...(options.operation === undefined ? {} : { operation: options.operation }),
        },
        subjects,
        costs,
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
