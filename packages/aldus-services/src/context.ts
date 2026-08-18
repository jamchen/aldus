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

import type { ActorRef } from "@aldus-runtime/core";
import { ArtifactRegistry, type ArtifactArchive } from "@aldus-runtime/artifact-registry";
import type { FileWorkspace } from "@aldus-runtime/file-store";
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
} from "@aldus-runtime/stage-runner";
import { TtsLedger, type SpendAuthorizer, type TtsRequestPlan } from "@aldus-runtime/tts-ledger";

import {
  EventStoreGateEventSink,
  LedgerEventStoreSink,
  RunStoreCostReader,
  RunStoreGateDecisionStore,
} from "./adapters.js";
import { fileLedgerStores, type LedgerLayout } from "./ledger-store.js";
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
   * Default actor for mutating operations (contract §19.2).
   *
   * Optional here and required at the point of mutation, so that a read-only caller need not
   * configure an identity to run `status` (§24).
   */
  actor?: ActorRef;
  /** Backend whose capabilities gate stage execution (contract §10). */
  backend?: AgentBackend;
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
  /** Spend grants in force, per plan (contract §13.2, §19.3). */
  spendGrants?: SpendGrantProvider;
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
  readonly subjectsFor: SubjectsProvider;
  readonly now: () => Date;

  /** The artifact registry for this workspace (contract §8). Always present — no adapter needed. */
  readonly artifacts: ArtifactRegistry;
  /** Release adapters supplied by the adopter, by destination (contract §17). */
  readonly releaseAdapters: AdapterRegistry;
  /** Where the TTS ledger's durable state lives (contract §15). */
  readonly ledgerLayout: LedgerLayout;

  readonly #synthesisAdapter: SynthesisAdapter | undefined;
  readonly #spendGrants: SpendGrantProvider | undefined;
  readonly #ledgerStores: ReturnType<typeof fileLedgerStores>;

  constructor(options: AldusContextOptions) {
    this.workspace = options.workspace;
    this.gateRegistry = options.gates ?? GateRegistry.from([]);
    this.stageRegistry = options.stages ?? new StageRegistry();
    this.actor = options.actor;
    this.backend = options.backend;
    this.subjectsFor = options.subjects ?? (() => Promise.resolve({}));
    this.now = options.now ?? (() => new Date());
    this.#synthesisAdapter = options.synthesisAdapter;
    this.#spendGrants = options.spendGrants;

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
      ...(this.backend !== undefined ? { backend: this.backend } : {}),
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
  synthesisFor(plan: TtsRequestPlan): SynthesisGateway | undefined {
    if (this.#synthesisAdapter === undefined) return undefined;
    return new SynthesisGateway({
      adapter: this.#synthesisAdapter,
      ledger: this.ledgerFor(plan),
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
    });
  }
}
