/**
 * Shared test fixtures.
 *
 * Every identifier here is fictional (`example-show`, `stage-a`, `workflow-a`). Contract §19.2
 * requires that private Knowledge Packs never be needed by tests, and §4.2 keeps provider,
 * platform, and adopter identities out of the runtime entirely — including its test data.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActorRef, CostRecord, Money } from "@aldus-runtime/core";
import { AldusError, SCHEMA_VERSION, newCostId } from "@aldus-runtime/core";
import { FileWorkspace, initWorkspace } from "@aldus-runtime/file-store";
import {
  GateRegistry,
  digestSubjectValue,
  type GateDefinition,
  type GateStatus,
  type SubjectsByGate,
} from "@aldus-runtime/gate-engine";
import {
  StageRegistry,
  type StageDefinition,
  type StageOutcome,
} from "@aldus-runtime/stage-runner";

import { AldusContext, AldusServices, type WorkflowGraph } from "../src/index.js";

/** A temporary workspace, removed after the test. */
export interface TempWorkspace {
  root: string;
  workspace: FileWorkspace;
  cleanup(): Promise<void>;
}

/** Create an initialised workspace in a fresh temp directory. */
export async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "aldus-services-"));
  await initWorkspace(root);
  const workspace = new FileWorkspace(root, { lockOptions: { retryMs: 1 } });
  return {
    root,
    workspace,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** The operator most tests act as. */
export const OPERATOR: ActorRef = { kind: "human", id: "operator-a", displayName: "Operator A" };

/** An agent actor, for tests about who may decide what (§13.3). */
export const AGENT: ActorRef = { kind: "agent", id: "agent-a", backendId: "backend-a" };

/** A frozen clock, so recorded timestamps are reproducible. */
export function fixedClock(iso = "2026-01-01T00:00:00.000Z"): () => Date {
  const instant = new Date(iso);
  return () => instant;
}

/** Build services over a workspace. */
export function makeServices(
  workspace: FileWorkspace,
  options: {
    gates?: readonly GateDefinition[];
    stages?: StageRegistry;
    actor?: ActorRef;
    subjects?: SubjectsByGate;
    workflow?: WorkflowGraph;
  } = {},
): AldusServices {
  const context = new AldusContext({
    workspace,
    gates: GateRegistry.from(options.gates ?? []),
    ...(options.stages !== undefined ? { stages: options.stages } : {}),
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
    ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
    subjects: () => Promise.resolve(options.subjects ?? {}),
    now: fixedClock(),
  });
  return new AldusServices(context);
}

/** A stage that always succeeds, returning what it was given. */
export function passthroughStage(id: string, version = "1"): StageDefinition<unknown, unknown> {
  return {
    id,
    version,
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    idempotency: { kind: "idempotent" },
    execute: (_context, input): Promise<StageOutcome<unknown>> =>
      Promise.resolve({ kind: "completed", output: input }),
  };
}

/**
 * A stage that fails, with the retryability the test asks for.
 *
 * Fails by throwing, which is how a real stage fails — the runner classifies the thrown error
 * rather than trusting a self-reported status (§19.1).
 */
export function failingStage(
  id: string,
  retryable: boolean,
  version = "1",
): StageDefinition<unknown, unknown> {
  return {
    id,
    version,
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    idempotency: { kind: "idempotent" },
    retryPolicy: { maxAttempts: 1 },
    execute: (): Promise<StageOutcome<unknown>> =>
      Promise.reject(
        new AldusError("ALDUS_EXAMPLE_FAILURE", "The stage could not complete.", {
          category: retryable ? "io" : "validation",
          retryable,
        }),
      ),
  };
}

/** A stage that halts at a gate (contract §11). */
export function gatedStage(
  id: string,
  gateId: string,
  version = "1",
): StageDefinition<unknown, unknown> {
  return {
    id,
    version,
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    idempotency: { kind: "idempotent" },
    execute: (): Promise<StageOutcome<unknown>> =>
      Promise.resolve({ kind: "gate_required", gateId, subjectHashes: [] }),
  };
}

/** A schema that accepts anything, for stages whose payload is not what is under test. */
const anySchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };

/** A registry holding the given stages. */
export function registryOf(...stages: StageDefinition<unknown, unknown>[]): StageRegistry {
  const registry = new StageRegistry();
  for (const stage of stages) registry.register(stage);
  return registry;
}

/** A gate status, defaulted to the shape most tests want. */
export function gateStatus(overrides: Partial<GateStatus> & { gateId: string }): GateStatus {
  return {
    level: "human_oracle",
    enforcement: "blocking",
    state: "pending",
    blocking: true,
    ...overrides,
  };
}

/** Subjects for a gate, digested the way the engine expects. */
export function subjectsFor(gateId: string, values: Record<string, unknown>): SubjectsByGate {
  return {
    [gateId]: Object.entries(values).map(([key, value]) => ({
      key,
      sha256: digestSubjectValue(value),
    })),
  };
}

/**
 * A gate definition with the fields the engine requires.
 *
 * `binds` is never empty: the engine refuses a gate that binds nothing, because an approval that
 * cannot be invalidated by a change would outlive the content it approved (§13.1, §13.2). Test
 * fixtures have to respect that rather than route around it.
 */
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

/** Subjects covering every gate in `gateIds`, so a decision on any of them is complete. */
export function subjectsForAll(gateIds: readonly string[], value = "value-a"): SubjectsByGate {
  const subjects: Record<string, { key: string; sha256: string }[]> = {};
  for (const gateId of gateIds) {
    subjects[gateId] = [{ key: "subject-a", sha256: digestSubjectValue(value) }];
  }
  return subjects;
}

/** A cost record with the billing status and amounts a test needs (§19.3). */
export function costRecord(options: {
  runId: string;
  billingStatus: CostRecord["billingStatus"];
  actual?: Money;
  estimated?: Money;
}): CostRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    costId: newCostId(),
    runId: options.runId,
    provider: "provider-a",
    operation: "operation-a",
    billingStatus: options.billingStatus,
    ...(options.actual !== undefined ? { actual: options.actual } : {}),
    ...(options.estimated !== undefined ? { estimated: options.estimated } : {}),
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
}
