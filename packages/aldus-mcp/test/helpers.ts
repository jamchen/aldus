/**
 * Production MCP test fixtures.
 *
 * Every identifier is fictional (§4.2, §19.2). Workspaces are real temp directories, because a
 * surface tested against a mocked store proves nothing about workspace binding.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initWorkspace } from "@aldus-runtime/file-store";
import type { GateDefinition } from "@aldus-runtime/gate-engine";
import { StageRegistry, type StageDefinition } from "@aldus-runtime/stage-runner";

import { CapabilityGrant, type Capability } from "../src/capabilities.js";
import type { CallerIdentity } from "../src/identity.js";
import { AldusToolSurface } from "../src/surface.js";

/** A temporary workspace, removed after the test. */
export interface TempWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

/** Create an initialised workspace in a fresh temp directory. */
export async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "aldus-mcp-"));
  await initWorkspace(root);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** The agent behind every test session. */
export const AGENT: CallerIdentity["agent"] = {
  id: "agent-a",
  displayName: "Agent A",
  backendId: "backend-a",
  sessionRef: "session-a",
};

/** A configured operator. */
export const OPERATOR_ACTOR = {
  kind: "human" as const,
  id: "operator-a",
  displayName: "Operator A",
};

/** Session identity with no operator configured. */
export const AGENT_ONLY: CallerIdentity = { agent: AGENT };

/** Session identity with an operator known only from configuration. */
export const AMBIENT_OPERATOR: CallerIdentity = {
  agent: AGENT,
  operator: { actor: OPERATOR_ACTOR, confirmation: "ambient_configuration" },
};

/** Session identity where the host attested to per-call human confirmation. */
export const CONFIRMED_OPERATOR: CallerIdentity = {
  agent: AGENT,
  operator: { actor: OPERATOR_ACTOR, confirmation: "per_call_confirmed" },
};

/** A stage that costs nothing. */
export function freeStage(id = "stage-free"): StageDefinition<unknown, unknown> {
  return {
    id,
    version: "1.0.0",
    inputSchema: undefined,
    outputSchema: undefined,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" },
    execute: () => Promise.resolve({ kind: "completed", output: { done: true } }),
  } as unknown as StageDefinition<unknown, unknown>;
}

/** A stage that declares it needs a recorded spend authorization (§19.3). */
export function paidStage(id = "stage-paid"): StageDefinition<unknown, unknown> {
  return {
    id,
    version: "1.0.0",
    inputSchema: undefined,
    outputSchema: undefined,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" },
    costPolicy: { supportsPreview: true, requiresAuthorization: true },
    execute: () => Promise.resolve({ kind: "completed", output: { done: true } }),
  } as unknown as StageDefinition<unknown, unknown>;
}

/** Options for {@link makeSurface}. */
export interface SurfaceOptions {
  root: string;
  identity?: CallerIdentity;
  capabilities?: Iterable<Capability>;
  stages?: readonly StageDefinition<unknown, unknown>[];
  gates?: readonly GateDefinition[];
}

/** Build a tool surface bound to a workspace. */
export function makeSurface(options: SurfaceOptions): AldusToolSurface {
  const registry = new StageRegistry();
  for (const stage of options.stages ?? []) registry.register(stage);

  return new AldusToolSurface({
    workspaceRoot: options.root,
    identity: options.identity ?? AGENT_ONLY,
    capabilities:
      options.capabilities === undefined
        ? CapabilityGrant.all()
        : new CapabilityGrant(options.capabilities),
    stages: registry,
    ...(options.gates !== undefined ? { gates: options.gates } : {}),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}
