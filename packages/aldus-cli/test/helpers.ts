/**
 * CLI test fixtures.
 *
 * The CLI is exercised in-process through an injected {@link CliEnvironment} rather than by
 * spawning `node`. A CLI tested only by subprocess tends to leave its interesting branches
 * untested, because reaching them means constructing state the subprocess cannot see.
 *
 * Every identifier is fictional (§4.2, §19.2).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION } from "@aldus-runtime/core";
import { initWorkspace } from "@aldus-runtime/file-store";
import {
  digestSubjectValue,
  type GateDefinition,
  type SubjectsByGate,
} from "@aldus-runtime/gate-engine";
import { requiredOperation, type ReleaseAdapter, type ReleaseBundle } from "@aldus-runtime/release";
import type {
  SpendGrantProvider,
  SynthesisAdapter,
  SynthesisOutcome,
  SynthesisRequest,
} from "@aldus-runtime/services";
import {
  StageRegistry,
  type StageDefinition,
  type StageOutcome,
} from "@aldus-runtime/stage-runner";
import type { PerformanceScript, TtsRequestPlan } from "@aldus-runtime/tts-ledger";

import { run, type CliEnvironment } from "../src/cli.js";
import type { ExitCode } from "../src/exit.js";

/** A temporary workspace, removed after the test. */
export interface TempWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

/** Create an initialised workspace in a fresh temp directory. */
export async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "aldus-cli-"));
  await initWorkspace(root);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** What one CLI invocation produced. */
export interface Invocation {
  code: ExitCode;
  stdout: string;
  stderr: string;
  /** Parsed stdout, for `--json` invocations. */
  json(): unknown;
}

/** Options shared across invocations in one test. */
export interface CliOptions {
  root: string;
  env?: Record<string, string | undefined>;
  stages?: StageRegistry;
  gates?: readonly GateDefinition[];
  subjects?: SubjectsByGate;
  /** Release adapters, as an operator's config module would supply (contract §4.3). */
  releaseAdapters?: readonly ReleaseAdapter[];
  /** The synthesis adapter. Omitted by default, so the unwired path is the default path. */
  synthesisAdapter?: SynthesisAdapter;
  /** Spend grants in force (contract §13.2, §19.3). */
  spendGrants?: SpendGrantProvider;
}

/** Invoke the CLI once. */
export async function invoke(options: CliOptions, ...argv: string[]): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];

  const environment: CliEnvironment = {
    argv,
    env: { ALDUS_WORKSPACE: options.root, ...options.env },
    cwd: options.root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...(options.stages !== undefined ? { stages: options.stages } : {}),
    ...(options.gates !== undefined ? { gates: options.gates } : {}),
    ...(options.releaseAdapters !== undefined ? { releaseAdapters: options.releaseAdapters } : {}),
    ...(options.synthesisAdapter !== undefined
      ? { synthesisAdapter: options.synthesisAdapter }
      : {}),
    ...(options.spendGrants !== undefined ? { spendGrants: options.spendGrants } : {}),
    subjects: () => Promise.resolve(options.subjects ?? {}),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };

  const code = await run(environment);
  const stdout = out.join("\n");
  return {
    code,
    stdout,
    stderr: err.join("\n"),
    json: () => JSON.parse(stdout) as unknown,
  };
}

/**
 * A synthesis adapter that records what it was asked to do.
 *
 * Counting calls is the point of every refusal test: proving the adapter was **never reached**
 * is what "no money was spent" means, and asserting on an exit code alone could not establish it.
 */
export class RecordingSynthesisAdapter implements SynthesisAdapter {
  readonly id = "adapter-a";
  readonly calls: SynthesisRequest[] = [];

  synthesise(request: SynthesisRequest): Promise<SynthesisOutcome> {
    this.calls.push(request);
    return Promise.resolve({
      providerRequestId: `request-${request.segmentId}`,
      audioSha256: "a".repeat(64),
      costRecordId: "cost-a",
    });
  }
}

/** Write a JSON document into the workspace and return its path, for `--bundle`/`--file`. */
export async function writeDocument(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
  return path;
}

/** A PerformanceScript with one segment (contract §14.1). */
export function aScript(runId: string): PerformanceScript {
  return {
    schemaVersion: SCHEMA_VERSION,
    scriptId: "script-a",
    runId,
    origin: "authored",
    segments: [{ segmentId: "seg-1", spokenText: "The first line." }],
    createdAt: "2026-01-01T00:00:00.000Z",
  } as PerformanceScript;
}

/** A request plan for one segment (contract §15, §13.2). */
export function aPlan(runId: string): TtsRequestPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    planId: "plan-a",
    runId,
    scriptId: "script-a",
    scriptSha256: "b".repeat(64),
    parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
    segments: [{ segmentId: "seg-1", text: { raw: "The first line." } }],
    estimatedTotal: { amount: "0.0100", currency: "USD" },
    createdAt: "2026-01-01T00:00:00.000Z",
  } as TtsRequestPlan;
}

/** A bundle with one required operation, against a destination a test adapter serves. */
export function aBundle(runId: string, episodeId: string): ReleaseBundle {
  return {
    bundleId: "bundle-a",
    runId,
    episodeId,
    required: [
      requiredOperation({
        operationId: "upload",
        kind: "media-upload",
        destination: DESTINATION_A,
        inputHashes: ["c".repeat(64)],
      }),
    ],
    bestEffort: [],
  };
}

/** The destination the test release adapter serves. Fictional, per §4.2. */
export const DESTINATION_A = "destination-a";

/** A stage that always succeeds. */
export function passthroughStage(id: string): StageDefinition<unknown, unknown> {
  return {
    id,
    version: "1",
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    idempotency: { kind: "idempotent" },
    execute: (_context, input): Promise<StageOutcome<unknown>> =>
      Promise.resolve({ kind: "completed", output: input }),
  };
}

/** A stage that halts at a gate (contract §11). */
export function gatedStage(id: string, gateId: string): StageDefinition<unknown, unknown> {
  return {
    id,
    version: "1",
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    idempotency: { kind: "idempotent" },
    execute: (): Promise<StageOutcome<unknown>> =>
      Promise.resolve({ kind: "gate_required", gateId, subjectHashes: [] }),
  };
}

/**
 * A stage that declares a real object-shaped input schema, as an adopter's stage does.
 *
 * Every other stage here uses {@link anySchema}, which accepts anything including `undefined`.
 * That is convenient and it hides the case every real stage is in: an object schema rejects
 * `undefined`, so whether the CLI supplies a value at all becomes load-bearing.
 */
export function objectInputStage(id: string): StageDefinition<unknown, unknown> {
  const objectSchema = {
    safeParse: (value: unknown) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? { success: true as const, data: value }
        : { success: false as const, error: new Error("expected an object") },
  };
  return {
    id,
    version: "1",
    inputSchema: objectSchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    idempotency: { kind: "idempotent" },
    execute: (_context, input): Promise<StageOutcome<unknown>> =>
      Promise.resolve({ kind: "completed", output: input }),
  };
}

const anySchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };

/** A registry holding the given stages. */
export function registryOf(...stages: StageDefinition<unknown, unknown>[]): StageRegistry {
  const registry = new StageRegistry();
  for (const stage of stages) registry.register(stage);
  return registry;
}

/** A gate definition binding one subject, as the engine requires (§13.1, §13.2). */
export function gateDefinition(
  gateId: string,
  overrides: Partial<GateDefinition> = {},
): GateDefinition {
  return {
    gateId,
    level: "human_oracle",
    enforcement: "blocking",
    binds: ["subject-a"],
    ...overrides,
  };
}

/** Subjects covering every named gate. */
export function subjectsForAll(gateIds: readonly string[], value = "value-a"): SubjectsByGate {
  const subjects: Record<string, { key: string; sha256: string }[]> = {};
  for (const gateId of gateIds) {
    subjects[gateId] = [{ key: "subject-a", sha256: digestSubjectValue(value) }];
  }
  return subjects;
}
