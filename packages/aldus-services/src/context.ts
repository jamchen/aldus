/**
 * The service context: everything a service needs, wired once.
 *
 * Contract §19.2 requires workspace binding to be explicit. Constructing this is that binding,
 * and it is also the seam that keeps §18's promise honest — the CLI and the Production MCP build
 * the same context and call the same methods, so neither can drift into having behaviour the
 * other lacks.
 *
 * ADR-0015 makes this the composition root: Aldus wires its own packages together and defines the
 * injection points, and an adopter supplies concrete adapters rather than reconstructing the
 * orchestration. So the artifact registry, the release executor, and the TTS ledger are all built
 * here, and the two things Aldus cannot supply — a release adapter and a synthesis adapter — are
 * constructor options.
 */

import { join } from "node:path";

import type { ActorKind, ActorRef, SpendReservation } from "@aldus-runtime/core";
import {
  ArtifactRegistry,
  stageArtifactRecorder,
  type ArtifactArchive,
} from "@aldus-runtime/artifact-registry";
import { FileSpendReservationStore, type FileWorkspace } from "@aldus-runtime/file-store";
import type { CostRecordStore } from "./cost-store.js";
import {
  openOperatorConsole,
  SpendService,
  type OperatorSpendConsole,
  type ReservationStatus,
} from "./spend-service.js";
import { RuntimePaidDispatchController, type DispatchSpendGrantProvider } from "./paid-dispatch.js";
import { RuntimeStageAgentDispatcher } from "./agent-dispatch.js";
import { GateEngine, GateRegistry, type SubjectsByGate } from "@aldus-runtime/gate-engine";
import {
  AdapterRegistry,
  ReleaseExecutor,
  gateEngineAuthorizer,
  eventStoreSink,
  runStoreReceipts,
  type ReleaseAdapter,
} from "@aldus-runtime/release";
import {
  StageRegistry,
  StageRunner,
  createStageRunner,
  type AgentBackend,
  type WorkerRegistry,
} from "@aldus-runtime/stage-runner";
import { TtsLedger, type SpendAuthorizer, type TtsRequestPlan } from "@aldus-runtime/tts-ledger";

import {
  EventStoreGateEventSink,
  LedgerEventStoreSink,
  RunStoreCostReader,
  RunStoreCostRecordStore,
  RunStoreGateDecisionStore,
} from "./adapters.js";
import { fileLedgerStores, type LedgerLayout } from "./ledger-store.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";
import {
  predecessorsOf,
  resolveRequiredGates,
  validateWorkflowGraph,
  type WorkflowGraph,
} from "./workflow.js";
import {
  SynthesisGateway,
  gateEngineSpendAuthorizer,
  type SpendGrantProvider,
  type SynthesisAdapter,
} from "./synthesis.js";

/**
 * Supplies the current digests of what each gate binds (contract §13.2).
 *
 * The services cannot compute these. What a gate binds — a spoken-text hash, a PerformanceScript
 * hash, a request plan — is adopter process (§4.3), and §4.2 keeps adopter concepts out of the
 * runtime. So the caller supplies them, and a gate with no subjects supplied evaluates as
 * `pending` rather than as satisfied: absence of evidence is never treated as approval.
 */
export type SubjectsProvider = (runId: string) => Promise<SubjectsByGate>;

/** Wiring for {@link AldusContext}. */
export interface AldusContextOptions {
  /** The bound workspace (contract §7, §19.2). */
  workspace: FileWorkspace;
  /** Gate definitions in force. Defaults to an empty registry — no gates, nothing blocking. */
  gates?: GateRegistry;
  /** Registered stage definitions (contract §11). Defaults to empty. */
  stages?: StageRegistry;
  /**
   * The workflow's stage↔gate graph (contract §11, ADR-0021).
   *
   * Optional. Without it, a stage's own `requiredGates` still applies, and a workflow that
   * declares neither behaves exactly as it did before ADR-0021.
   */
  workflow?: WorkflowGraph;
  /**
   * Default actor for mutating operations (contract §19.2).
   *
   * Optional here and required at the point of mutation, so that a read-only caller need not
   * configure an identity to run `status` (§24).
   */
  actor?: ActorRef;
  /** Backend whose capabilities gate stage execution (contract §10). */
  backend?: AgentBackend;
  /**
   * Workers a stage may invoke through `StageContext.runWorker` (§4.1, ADR-0035).
   *
   * Held here rather than only on the runner because this is the composition root: an option a
   * runner accepts but a composition cannot supply is a capability no adopter can reach, which is
   * #67 and the reason this field exists at all.
   */
  workers?: WorkerRegistry;
  /** Current digests of what gates bind. Defaults to supplying none. */
  subjects?: SubjectsProvider;
  /** Clock, injectable so tests produce reproducible timestamps. */
  now?: () => Date;

  /**
   * Adapters that perform release operations (contract §17, §4.3).
   *
   * Injected, never imported: §4.2 keeps publishing platforms out of the runtime and §1.2 rules
   * out prescribing release targets. Aldus owns the orchestration, the idempotency, and the
   * refusal; the adapter talks to a destination.
   */
  releaseAdapters?: readonly ReleaseAdapter[];
  /**
   * The adapter that performs synthesis (contract §14, §15, §4.3).
   *
   * Injected for the same reason. Held only inside {@link AldusContext.synthesis} so that nothing
   * can reach it without §13.2's authorization succeeding first — see `synthesis.ts`.
   */
  synthesisAdapter?: SynthesisAdapter;
  /**
   * Actor kinds that may accept or reject a take (contract §13.3). Defaults to `["human"]`.
   *
   * Threaded through to {@link TtsLedger} because it could not be supplied otherwise. The option
   * exists so §13.3's "until a scoped evaluator is demonstrably reliable" is reachable — #100 had
   * enforced the clause as an absolute, which protected the supervised case and made the "until"
   * satisfiable by nobody — and `ledgerFor` never passed it, so the clause was unreachable again
   * through every composition anyone actually writes.
   *
   * An option documented as configurable that no composition can supply is decoration. Found by
   * an adopter as the fourth instance of that shape, after `workflow`, `agentBackend` and
   * `workers`.
   *
   * The default stays human-only, and the asymmetry is deliberate: a supervised show that
   * accidentally permits agents loses its human-ear guarantee **silently**, while an automated
   * show that accidentally forbids them fails loudly on its first take. Opt out by declaration,
   * never by omission (ADR-0034).
   */
  takeDecisionActorKinds?: readonly ActorKind[];
  /** Spend grants in force, per plan (contract §13.2, §19.3). */
  spendGrants?: SpendGrantProvider;
  /**
   * Spend grants in force for a Worker operation (§13.2, §19.3; #107).
   *
   * Separate from {@link spendGrants} because the keys are different questions: a synthesis grant
   * is looked up by plan, and a Worker grant by the operation the invocation declares. Keying a
   * Worker grant by Worker would let swapping an implementation change what is authorized, which
   * is a substitution no operator approved.
   *
   * Absent means no Worker operation is authorized to spend, and every paid invocation is refused
   * before dispatch. That is the fail-closed direction: the alternative is a composition where
   * forgetting to wire a grant provider makes paid Workers run unbudgeted.
   */
  dispatchSpendGrants?: DispatchSpendGrantProvider;
  /** Where irreplaceable artifact bytes are kept. Defaults to a local archive (contract §8.1). */
  archive?: ArtifactArchive;
}

/** Everything the services operate against, bound to one workspace. */
export class AldusContext {
  readonly workspace: FileWorkspace;
  readonly gateRegistry: GateRegistry;
  readonly stageRegistry: StageRegistry;
  readonly gates: GateEngine;
  readonly actor: ActorRef | undefined;
  readonly backend: AgentBackend | undefined;
  readonly workers: WorkerRegistry | undefined;
  readonly subjectsFor: SubjectsProvider;
  readonly now: () => Date;

  /** The artifact registry for this workspace (contract §8). Always present — no adapter needed. */
  readonly artifacts: ArtifactRegistry;
  /** Release adapters supplied by the adopter, by destination (contract §17). */
  readonly releaseAdapters: AdapterRegistry;
  /** Where the TTS ledger's durable state lives (contract §15). */
  readonly ledgerLayout: LedgerLayout;
  /** The workflow's stage↔gate graph, when the adopter supplied one (contract §11). */
  readonly workflow: WorkflowGraph | undefined;

  readonly #synthesisAdapter: SynthesisAdapter | undefined;
  readonly #costs: CostRecordStore;
  readonly #spend: SpendService;
  readonly #spendGrants: SpendGrantProvider | undefined;
  readonly #paidDispatch: RuntimePaidDispatchController;
  readonly #agentDispatch: RuntimeStageAgentDispatcher | undefined;
  readonly #ledgerStores: ReturnType<typeof fileLedgerStores>;
  readonly #takeDecisionActorKinds: readonly ActorKind[] | undefined;

  constructor(options: AldusContextOptions) {
    this.workspace = options.workspace;
    this.gateRegistry = options.gates ?? GateRegistry.from([]);
    this.stageRegistry = options.stages ?? new StageRegistry();
    // A graph that cannot be satisfied is refused where it is supplied, not where a Run wedges.
    // Checked here rather than in the CLI's config validation so every consumer benefits, not
    // only the binary (ADR-0015, ADR-0028).
    if (options.workflow !== undefined) {
      const problems = validateWorkflowGraph(options.workflow);
      if (problems.length > 0) {
        throw serviceError(
          ServiceErrorCodes.INVALID_REQUEST,
          `The workflow graph is not satisfiable:\n${problems
            .map((problem) => `  - ${problem.message}`)
            .join("\n")}`,
          {
            category: "validation",
            details: {
              problems: problems.map((problem) => ({
                kind: problem.kind,
                stages: problem.stages,
              })),
            },
          },
        );
      }
    }
    this.workflow = options.workflow;
    this.actor = options.actor;
    this.backend = options.backend;
    this.workers = options.workers;
    this.subjectsFor = options.subjects ?? (() => Promise.resolve({}));
    this.now = options.now ?? (() => new Date());
    this.#synthesisAdapter = options.synthesisAdapter;
    this.#spendGrants = options.spendGrants;
    this.#costs = new RunStoreCostRecordStore(this.workspace.runs);
    // Reservations live beside the workspace rather than inside a Run: a grant is the contended
    // budget pool and may be drawn on by several Runs, so partitioning them per Run would put
    // competing writers in different files and lose the contention the protocol exists to manage
    // (ADR-0044, #158).
    this.#spend = new SpendService({
      store: new FileSpendReservationStore({
        root: join(this.workspace.layout.root, "spend", "reservations"),
        locks: this.workspace.locks,
      }),
      costs: this.#costs,
      now: () => this.now(),
    });

    this.#paidDispatch = new RuntimePaidDispatchController({
      spend: this.#spend,
      costs: this.#costs,
      // No provider wired means no operation is authorized, rather than every operation being
      // authorized by default.
      grants: options.dispatchSpendGrants ?? (() => undefined),
      now: () => this.now(),
    });

    this.#agentDispatch =
      this.backend === undefined
        ? undefined
        : new RuntimeStageAgentDispatcher({
            backend: this.backend,
            spend: this.#spend,
            costs: this.#costs,
            events: { append: (runId, event) => this.workspace.events.append(runId, event) },
            grants: options.dispatchSpendGrants ?? (() => undefined),
            now: () => this.now(),
          });

    this.gates = new GateEngine({
      registry: this.gateRegistry,
      decisions: new RunStoreGateDecisionStore(this.workspace.runs),
      costs: new RunStoreCostReader(this.workspace.runs),
      events: new EventStoreGateEventSink(this.workspace.events),
    });

    this.artifacts = new ArtifactRegistry(this.workspace.layout.root, this.workspace.locks, {
      ...(options.archive !== undefined ? { archive: options.archive } : {}),
      now: this.now,
    });

    this.releaseAdapters = new AdapterRegistry(options.releaseAdapters ?? []);

    const stores = fileLedgerStores(this.workspace.layout, this.workspace.locks);
    this.ledgerLayout = stores.layout;
    this.#ledgerStores = stores;
    this.#takeDecisionActorKinds = options.takeDecisionActorKinds;
  }

  /**
   * Gates that gate one stage (contract §11, ADR-0021).
   *
   * Returns `undefined` when neither the workflow graph nor the stage definition declares an
   * association — which the next-action policy reads as "undeclared", not as "requires nothing".
   *
   * When several versions of a stage are registered, the latest is consulted. `versionsOf` sorts,
   * so the last entry is the highest version. Reading every version and merging would let a
   * retired definition keep gating a stage its current version no longer gates.
   */
  requiredGatesFor(stageId: string): readonly string[] | undefined {
    const versions = this.stageRegistry.versionsOf(stageId);
    const latest = versions[versions.length - 1];
    const definition = latest === undefined ? undefined : this.stageRegistry.get(stageId, latest);
    const resolution = resolveRequiredGates(stageId, this.workflow, definition?.requiredGates);
    return resolution.declared ? resolution.gates : undefined;
  }

  /**
   * Stages that must succeed before one stage may run (contract §11, ADR-0028).
   *
   * Empty when the stage declares no ordering. Unlike {@link AldusContext.requiredGatesFor}, there
   * is no undeclared/declared-empty distinction to preserve: an edge only ever adds a
   * precondition, so absence and "no predecessors" mean the same thing.
   */
  predecessorsFor(stageId: string): readonly string[] {
    return predecessorsOf(stageId, this.workflow);
  }

  /** True when an adopter supplied a synthesis adapter (contract §4.3). */
  get hasSynthesisAdapter(): boolean {
    return this.#synthesisAdapter !== undefined;
  }

  /**
   * A stage runner bound to this workspace and actor.
   *
   * Built per call rather than held, because the runner records the actor on every attempt
   * (§19.2) and a service may be invoked by a different actor than the one the context was
   * constructed with.
   */
  runnerFor(actor: ActorRef): StageRunner {
    return createStageRunner(this.workspace, {
      registry: this.stageRegistry,
      actor,
      // Without this a stage's `registerOutput` refuses with ARTIFACT_RECORDER_UNAVAILABLE, so
      // the capability exists on the context, is reachable as `context.artifacts`, and is
      // unusable from every stage the services actually run. The refusal is correct — a stage
      // that believed it registered an irreplaceable take and had not would find out the day a
      // cleanup removed the bytes — which is exactly why the port has to be wired rather than
      // the refusal softened.
      artifacts: stageArtifactRecorder(this.artifacts),
      ...(this.backend !== undefined ? { backend: this.backend } : {}),
      ...(this.workers !== undefined ? { workers: this.workers } : {}),
      // The half #107 was missing. A Worker may be paid — §3.2's own examples are TTS invocation
      // and rendering — and without this the runner refuses every paid invocation rather than
      // dispatching it unauthorized. Wired unconditionally: the grant provider answers `undefined`
      // when no grant is in force, and a reservation for an unauthorized operation is refused
      // there rather than by the absence of a controller.
      paidDispatch: this.#paidDispatch,
      // Only where a backend is configured. Wiring a dispatcher *because* a backend exists is not
      // the same as dispatching because it exists — the stage still has to ask (ADR-0047).
      ...(this.#agentDispatch === undefined ? {} : { agentDispatch: this.#agentDispatch }),

      now: this.now,
    });
  }

  /**
   * A release executor whose authority checks are bound to one Run (contract §13.4, §17).
   *
   * Built per Run because `gateEngineAuthorizer` reads subjects through a zero-argument function,
   * so the Run has to be captured. Reading subjects afresh on every check is what makes an
   * approval that has since drifted refuse at the moment of release rather than at planning
   * (ADR-0009).
   */
  releaseExecutorFor(runId: string): ReleaseExecutor {
    return new ReleaseExecutor({
      adapters: this.releaseAdapters,
      receipts: runStoreReceipts(this.workspace.runs),
      events: eventStoreSink(this.workspace.events),
      authorizer: gateEngineAuthorizer(this.gates, () => this.subjectsFor(runId)),
      now: this.now,
    });
  }

  /**
   * A TTS ledger for this workspace (contract §14, §15).
   *
   * The spend authorizer is bound to a specific plan, because §13.2 requires the approval to bind
   * *that plan's* digests and `gateEngineSpendAuthorizer` verifies exactly that. A ledger built
   * without a plan gets no authorizer at all, which makes `permitSynthesis` refuse — the correct
   * default, since a ledger with nothing to ask must not assume consent.
   */
  ledgerFor(plan?: TtsRequestPlan): TtsLedger {
    const authorizer = this.#authorizerFor(plan);
    return new TtsLedger({
      takes: this.#ledgerStores.takes,
      plans: this.#ledgerStores.plans,
      scripts: this.#ledgerStores.scripts,
      lexicon: this.#ledgerStores.lexicon,
      events: new LedgerEventStoreSink(this.workspace.events),
      ...(authorizer === undefined ? {} : { authorizer }),
      ...(this.#takeDecisionActorKinds === undefined
        ? {}
        : { permittedDecisionActorKinds: this.#takeDecisionActorKinds }),
      now: this.now,
    });
  }

  /**
   * The synthesis gateway, when an adapter was supplied (contract §13.2, §14, §15).
   *
   * Returns `undefined` rather than throwing so a caller can report "no adapter is wired" as the
   * wiring error it is. The adapter itself is never exposed by this class: the gateway is the only
   * thing that holds it, and the gateway authorizes before it calls.
   */
  /**
   * Reservation status for a Run — read-only, and the whole of the supported spend surface.
   *
   * There is deliberately no `operatorConsole()` here. Reconciliation releases authorization for
   * money, and the only identity this composition has is `AldusContextOptions.actor`, which the
   * CLI fills from the `--actor` flag or `ALDUS_ACTOR`. That is an attribution convention: it says
   * who a command claims to be, and nothing authenticates it. Handing it to a reconciliation would
   * have made "a human decided this" a fact derived from a string the caller chose.
   *
   * So status ships and reconciliation does not. `SpendService.reconcile` exists and requires an
   * authority no public surface can mint, which makes it unreachable rather than weakly guarded —
   * until Aldus has a boundary that establishes operator identity or human presence, at which
   * point that boundary becomes the mint.
   */
  /**
   * The operator console for a human adjudicating an unresolved charge (#155 step 5, #215).
   *
   * **This was removed once, deliberately** — `9c85cf4`, *"authority comes from a boundary, not a
   * parameter"* — because wiring the mint to the CLI's self-declared actor made it *look*
   * trustworthy. Re-added under a ruling that settles what the bar actually is.
   *
   * The reasoning: the same trust level was already accepted where it does more damage.
   * `aldus approve performance.freeze` establishes a spend grant and authorises paid synthesis on
   * nothing but `ALDUS_ACTOR`. Refusing reconciliation on a stricter bar guarded one path while
   * the path that actually releases money was open — and the cost of the asymmetry was a Run made
   * terminal, two `human_oracle` approvals re-made by hand, and $12.57 of settled work redone.
   *
   * What changed is not the trust. It is that the record can now say who decided and who typed,
   * so a transcription is distinguishable from a claim (ADR-0054).
   */
  operatorConsole(actor: ActorRef | undefined): OperatorSpendConsole {
    return openOperatorConsole({ spend: this.#spend, actor });
  }

  /** @see SpendService.readReservation */
  readReservation(grantId: string, reservationId: string): Promise<SpendReservation> {
    return this.#spend.readReservation(grantId, reservationId);
  }

  spendStatus(runId: string): Promise<readonly ReservationStatus[]> {
    return this.#spend.status(runId);
  }

  synthesisFor(plan: TtsRequestPlan): SynthesisGateway | undefined {
    if (this.#synthesisAdapter === undefined) return undefined;
    return new SynthesisGateway({
      adapter: this.#synthesisAdapter,
      ledger: this.ledgerFor(plan),
      // Wired here rather than left to each caller: the gateway is the only path to a synthesis
      // provider, so a composition that reached it without a cost store could report a charge
      // with nowhere to record it (#160).
      ...(this.#costs === undefined ? {} : { costs: this.#costs }),
      ...(this.#spendGrants === undefined ? {} : { grants: this.#spendGrants }),
      spend: this.#spend,
    });
  }

  /** The spend authorizer for one plan, or `undefined` when no grants are wired. */
  #authorizerFor(plan: TtsRequestPlan | undefined): SpendAuthorizer | undefined {
    if (plan === undefined || this.#spendGrants === undefined) return undefined;
    return gateEngineSpendAuthorizer({
      engine: this.gates,
      grants: this.#spendGrants,
      subjects: this.subjectsFor,
      plan,
      operation: "synthesis",
      costs: this.#costs,
    });
  }
}
