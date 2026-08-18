/**
 * The service context: everything a service needs, wired once.
 *
 * Contract §19.2 requires workspace binding to be explicit. Constructing this is that binding,
 * and it is also the seam that keeps §18's promise honest — the CLI and the Production MCP build
 * the same context and call the same methods, so neither can drift into having behaviour the
 * other lacks.
 */

import type { ActorRef } from "@aldus-runtime/core";
import type { FileWorkspace } from "@aldus-runtime/file-store";
import { GateEngine, GateRegistry, type SubjectsByGate } from "@aldus-runtime/gate-engine";
import {
  StageRegistry,
  StageRunner,
  createStageRunner,
  type AgentBackend,
} from "@aldus-runtime/stage-runner";

import {
  EventStoreGateEventSink,
  RunStoreCostReader,
  RunStoreGateDecisionStore,
} from "./adapters.js";

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

  constructor(options: AldusContextOptions) {
    this.workspace = options.workspace;
    this.gateRegistry = options.gates ?? GateRegistry.from([]);
    this.stageRegistry = options.stages ?? new StageRegistry();
    this.actor = options.actor;
    this.backend = options.backend;
    this.subjectsFor = options.subjects ?? (() => Promise.resolve({}));
    this.now = options.now ?? (() => new Date());

    this.gates = new GateEngine({
      registry: this.gateRegistry,
      decisions: new RunStoreGateDecisionStore(this.workspace.runs),
      costs: new RunStoreCostReader(this.workspace.runs),
      events: new EventStoreGateEventSink(this.workspace.events),
    });
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
}
