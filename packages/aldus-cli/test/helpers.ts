/**
 * CLI test fixtures.
 *
 * The CLI is exercised in-process through an injected {@link CliEnvironment} rather than by
 * spawning `node`. A CLI tested only by subprocess tends to leave its interesting branches
 * untested, because reaching them means constructing state the subprocess cannot see.
 *
 * Every identifier is fictional (§4.2, §19.2).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initWorkspace } from "@aldus-runtime/file-store";
import {
  digestSubjectValue,
  type GateDefinition,
  type SubjectsByGate,
} from "@aldus-runtime/gate-engine";
import {
  StageRegistry,
  type StageDefinition,
  type StageOutcome,
} from "@aldus-runtime/stage-runner";

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
