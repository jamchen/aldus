/**
 * The composed stack, wired the way an adopter would wire it (ADR-0015).
 *
 * The single most important thing this file provides is {@link Stack.restart}: a **fresh**
 * `AldusServices` over the **same workspace directory**, with every in-memory object discarded.
 * Architecture contract §3.4 says files and Runtime state are authoritative and session memory is
 * not, and §5.1 says long pauses between stages are normal — so a journey that only ever ran
 * against one process-lifetime instance would prove nothing about either claim.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActorRef } from "@aldus-runtime/core";
import { LocalDirectoryArchive, type ArtifactRegistry } from "@aldus-runtime/artifact-registry";
import { FileWorkspace, initWorkspace } from "@aldus-runtime/file-store";
import {
  GateRegistry,
  type GateDefinition,
  type SpendGrant,
  type SubjectsByGate,
} from "@aldus-runtime/gate-engine";
import { RecordingReleaseAdapter, type RecordingAdapterOptions } from "@aldus-runtime/release";
import { AldusContext, AldusServices, isIssuedSynthesisPermit } from "@aldus-runtime/services";
import { StageRegistry, type StageDefinition } from "@aldus-runtime/stage-runner";

import { FakeSynthesisAdapter } from "./adapters.js";
import { DESTINATION_A } from "./fixtures.js";

/** The operator every scenario acts as, unless it is testing anonymity (§19.2). */
export const OPERATOR: ActorRef = {
  kind: "human",
  id: "operator-a",
  displayName: "Operator A",
};

/** An agent actor, for scenarios about who may decide what (§13.3). */
export const AGENT: ActorRef = { kind: "agent", id: "agent-a", backendId: "backend-a" };

/** A frozen clock, so every recorded timestamp is reproducible. */
export function fixedClock(iso = "2026-01-01T00:00:00.000Z"): () => Date {
  const instant = new Date(iso);
  return () => instant;
}

/** Mutable state the scenario controls between service calls. */
export interface StackState {
  /** What each gate currently binds. Reassign to make a subject drift (§13.1). */
  subjects: SubjectsByGate;
  /**
   * The spend grant in force.
   *
   * A grant names the `GateDecision` that authorized it, and a decision's id is minted when it is
   * recorded — so no fixture can know it in advance. A scenario approves first, then sets the
   * grant to cite the decision it just created, which is the order an operator works in too.
   */
  grant: SpendGrant | undefined;
}

/**
 * Supplies the stages for one context.
 *
 * A factory rather than an array, because a stage that registers artifacts needs the registry —
 * and the registry is created *by* the context, which is created *from* the stage registry. A
 * plain array cannot close that loop, and building a throwaway context to borrow a registry from
 * would bind the stages to the wrong workspace root.
 *
 * Called afresh on every build, so stages survive {@link Stack.restart} bound to the *new*
 * context's registry rather than a stale one.
 */
export type StageFactory = (
  registry: ArtifactRegistry,
  workingRoot: string,
) => readonly StageDefinition<unknown, unknown>[];

/** How to build the stack. */
export interface StackOptions {
  gates?: readonly GateDefinition[];
  stages?: StageFactory;
  /** Pass `null` for a context with no default actor, to exercise §19.2's refusal. */
  actor?: ActorRef | null;
  /** Omit the synthesis adapter entirely, modelling an adopter that wired none. */
  withSynthesisAdapter?: boolean;
  /** Omit the release adapter entirely. */
  withReleaseAdapter?: boolean;
  /** Omit the grant provider, so no spend authorizer exists at all. */
  withGrants?: boolean;
  /** Scripted release outcomes per `operationId`; anything unlisted succeeds. */
  releaseOutcomes?: RecordingAdapterOptions["outcomes"];
}

/** A composed stack over one temporary workspace. */
export interface Stack {
  /** Absolute path of the workspace root. */
  root: string;
  /** Where stages write their working files. */
  workingRoot: string;
  /** The current services instance. Replaced by {@link Stack.restart}. */
  services: AldusServices;
  /** The adopter's synthesis double. Survives a restart, as a real adapter would. */
  synthesis: FakeSynthesisAdapter;
  /** The adopter's release double. Survives a restart. */
  release: RecordingReleaseAdapter;
  /** Mutable scenario state, read afresh on every service call. */
  state: StackState;
  /**
   * Discard everything in memory and rebuild the services over the same directory.
   *
   * Returns the new instance, and also replaces {@link Stack.services}. The adapters and the
   * scenario state deliberately survive: an adapter and an operator's decisions outlive a process,
   * and pretending otherwise would make the restart prove less than it should.
   */
  restart(): AldusServices;
  cleanup(): Promise<void>;
}

/**
 * Build a composed stack in a fresh temporary directory.
 *
 * Every package the operator surface reaches is wired here, which is the point: this is the
 * composition root ADR-0015 describes, exercised as a whole rather than one seam at a time.
 */
export async function makeStack(options: StackOptions = {}): Promise<Stack> {
  const root = await mkdtemp(join(tmpdir(), "aldus-e2e-"));
  await initWorkspace(root);

  const synthesis = new FakeSynthesisAdapter();
  const release = new RecordingReleaseAdapter(DESTINATION_A, {
    ...(options.releaseOutcomes === undefined ? {} : { outcomes: options.releaseOutcomes }),
  });
  synthesis.verifyWith(isIssuedSynthesisPermit);

  const state: StackState = { subjects: {}, grant: undefined };
  const actor = options.actor === null ? undefined : (options.actor ?? OPERATOR);

  const workingRoot = join(root, "working");

  const build = (): AldusServices => {
    // A new workspace, registry, gate engine, ledger, and executor on every call. Nothing from
    // the previous instance is carried over, so anything that still works afterwards works
    // because it was written to disk.
    const workspace = new FileWorkspace(root, { lockOptions: { retryMs: 1 } });
    const stageRegistry = new StageRegistry();

    const context = new AldusContext({
      workspace,
      gates: GateRegistry.from(options.gates ?? []),
      stages: stageRegistry,
      ...(actor === undefined ? {} : { actor }),
      subjects: () => Promise.resolve(state.subjects),
      now: fixedClock(),
      archive: new LocalDirectoryArchive(join(root, ".aldus", "archive")),
      ...(options.withSynthesisAdapter === false ? {} : { synthesisAdapter: synthesis }),
      ...(options.withReleaseAdapter === false ? {} : { releaseAdapters: [release] }),
      ...(options.withGrants === false ? {} : { spendGrants: () => state.grant }),
    });

    // Registered *after* the context exists, so the stages can be handed the registry the context
    // just built. `runnerFor` reads `stageRegistry` at call time and the registry is held by
    // reference, so a stage registered now is visible to every later run.
    for (const stage of options.stages?.(context.artifacts, workingRoot) ?? []) {
      stageRegistry.register(stage);
    }
    return new AldusServices(context);
  };

  const stack: Stack = {
    root,
    workingRoot,
    services: build(),
    synthesis,
    release,
    state,
    restart(): AldusServices {
      stack.services = build();
      return stack.services;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  return stack;
}
