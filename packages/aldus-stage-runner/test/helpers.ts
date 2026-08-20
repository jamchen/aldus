/**
 * Shared test scaffolding.
 *
 * Every test runs against a real temp workspace and the real file store. The behaviours this
 * package must get right — an append-only attempt record, a cache repaired after a crash, a lock
 * held only for a write — are properties of real files, and a mocked store would assert only that
 * the test's own assumptions are self-consistent.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActorRef, ArtifactRef, RunManifest } from "@aldus-runtime/core";
import { openWorkspace, type FileWorkspace } from "@aldus-runtime/file-store";
import { builders, createTestContext, type TestContext } from "@aldus-runtime/testkit";
import { z } from "zod";

import type { AgentBackend, AgentCapabilities } from "../src/backend.js";
import type {
  ArtifactRecorder,
  StageDefinition,
  StageOutcome,
  StageContext,
} from "../src/definition.js";
import { StageRegistry } from "../src/registry.js";
import { StageRunner } from "../src/runner.js";
import type { WorkerRegistry } from "../src/worker.js";
import { stageStatePathFor } from "../src/workspace.js";

/** A temp workspace root, its stores, and its cleanup. */
export interface TempRun {
  root: string;
  workspace: FileWorkspace;
  manifest: RunManifest;
  registry: StageRegistry;
  runner: StageRunner;
  stageStatePath(runId: string): string;
  cleanup(): Promise<void>;
}

/** A deterministic builder context, so record identities are reproducible across runs. */
export function context(): TestContext {
  return createTestContext();
}

export const TEST_ACTOR: ActorRef = { kind: "human", id: "operator-a" };

/** Monotonic id minting, so an attempt or event id is readable in a failure message. */
function counter(prefix: string): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}_${String(next).padStart(4, "0")}`;
  };
}

/** Options for {@link makeTempRun}. */
export interface TempRunOptions {
  backend?: AgentBackend;
  /** Recorded delays instead of real waiting, so retry tests do not sleep. */
  sleeps?: number[];
  /** Where `registerOutput` sends files. Omitted so the unwired refusal stays testable. */
  artifacts?: ArtifactRecorder;
  /**
   * Override the Run manifest's identity.
   *
   * The testkit builders are deterministic, so two bare `makeTempRun()` calls produce the **same**
   * `runId` and `episodeId` — separate temp directories, identical manifests. Any test comparing
   * behaviour "across runs" or "across episodes" must vary these explicitly, or it compares a
   * value with itself and passes for the wrong reason.
   */
  manifest?: { runId?: string; episodeId?: string };
  /** Workers a stage may invoke (ADR-0035). Omitted so the unwired refusal stays testable. */
  workers?: WorkerRegistry;
}

/** Create an isolated workspace with one Run, and a runner bound to it. */
export async function makeTempRun(options: TempRunOptions = {}): Promise<TempRun> {
  const root = await mkdtemp(join(tmpdir(), "aldus-stage-runner-"));
  const workspace = await openWorkspace(root);
  const ctx = context();
  const built = builders.RunManifest(undefined, ctx);
  const manifest = {
    ...built,
    ...(options.manifest?.runId !== undefined ? { runId: options.manifest.runId } : {}),
    ...(options.manifest?.episodeId !== undefined
      ? { episode: { ...built.episode, episodeId: options.manifest.episodeId } }
      : {}),
  };
  await workspace.runs.create(manifest);

  const registry = new StageRegistry();
  let clock = Date.parse("2026-01-01T00:00:00.000Z");

  const runner = new StageRunner({
    runs: workspace.runs,
    events: workspace.events,
    locks: workspace.locks,
    stageStatePath: (runId) => stageStatePathFor(workspace, runId),
    registry,
    actor: TEST_ACTOR,
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    ...(options.workers !== undefined ? { workers: options.workers } : {}),
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    sleep: async (ms) => {
      options.sleeps?.push(ms);
    },
    newAttemptId: counter("att"),
    newEventId: counter("evt"),
  });

  return {
    root,
    workspace,
    manifest,
    registry,
    runner,
    stageStatePath: (runId) => stageStatePathFor(workspace, runId),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A well-formed artifact, for stages that record outputs. */
export function anArtifact(overrides: Partial<ArtifactRef> = {}, ctx = context()): ArtifactRef {
  return builders.ArtifactRef(overrides, ctx);
}

/** Passthrough schema, for stages whose input or output shape is not what a test is about. */
export const anySchema = z.unknown();

/** Build a stage definition with sensible defaults, overriding only what a test cares about. */
export function aStage<I = unknown, O = unknown>(
  overrides: Partial<StageDefinition<I, O>> & {
    execute?: (context: StageContext, input: I) => Promise<StageOutcome<O>>;
  } = {},
): StageDefinition<I, O> {
  return {
    id: "stage-a",
    version: "1.0.0",
    inputSchema: anySchema as unknown as StageDefinition<I, O>["inputSchema"],
    outputSchema: anySchema as unknown as StageDefinition<I, O>["outputSchema"],
    requiredCapabilities: [],
    idempotency: { kind: "idempotent" },
    execute: async () => ({ kind: "completed", output: undefined as O }),
    ...overrides,
  };
}

/** A backend offering exactly the named capabilities (contract §10). */
export function aBackend(offers: string[] = [], id = "backend-a"): AgentBackend {
  const capabilities: AgentCapabilities = { offers, interactive: true, resumable: false };
  return {
    id,
    capabilities: async () => capabilities,
    execute: async () => ({ ok: true }),
  };
}
