/**
 * The Agent Backend boundary (architecture contract §10).
 *
 * §10 opens with the rule this file exists to keep honest: **"The Runtime MUST NOT equal Claude
 * Code or Codex."** So this module defines the interface a backend satisfies and the capability
 * check the runner performs — and implements no backend at all. §4.2 keeps provider identities
 * out of the runtime, and there is no adopter to write one for.
 *
 * The runner needs exactly one thing from a backend before it will execute: confirmation that the
 * capabilities a stage declared as required are actually offered. §10 lists what capabilities
 * *describe* (interactive or headless operation, filesystem access, available tools, structured
 * output, resumability, duration limits, permissions, cost budgets) but names no closed set, so
 * capability names stay open strings.
 */

import type { ActorRef } from "@aldus/core";

import { StageRunnerErrorCodes, stageRunnerError } from "./errors.js";

/**
 * What a backend can do (contract §10 "Capabilities SHOULD declare").
 *
 * `offers` is an open set of names rather than a fixed record of booleans. §10's list is
 * illustrative, and a fixed record would have to change in Core every time a backend gained an
 * ability — the coupling §4.2 forbids.
 */
export interface AgentCapabilities {
  /** Capability names this backend offers. Open strings, matched exactly. */
  offers: readonly string[];
  /** Whether the backend can be driven interactively (contract §5.1, §10). */
  interactive: boolean;
  /** Whether an execution can be resumed after a pause (contract §10, §19.1). */
  resumable: boolean;
  /** Ceiling on a single execution, if the backend imposes one (contract §10). */
  maxDurationMs?: number;
}

/** Reference to a resumable backend session (contract §10). */
export interface AgentSessionRef {
  /** Backend-assigned session identity. Opaque to the runtime. */
  sessionId: string;
  /** Backend that owns the session. */
  backendId: string;
}

/** A unit of work handed to a backend (contract §10). */
export interface AgentRequest {
  /** Identity correlating this execution with the attempt that issued it. */
  executionId: string;
  /** What the backend is being asked to do. */
  instructions: string;
  /** Structured input. Redacted before it reaches any durable record (contract §19.2). */
  input?: Record<string, unknown>;
  /** Capabilities this request needs. Checked before dispatch. */
  requiredCapabilities?: readonly string[];
  /** Cancellation (contract §19.1). */
  signal?: AbortSignal;
}

/** What a backend returns (contract §10). */
export interface AgentResult {
  /** Whether the backend completed the request. */
  ok: boolean;
  /** Structured output, when the backend produced one. */
  output?: unknown;
  /** Session to resume from, when the backend supports resumption. */
  session?: AgentSessionRef;
  /** Failure detail, already redacted (contract §19.2). */
  error?: import("@aldus/core").StructuredError;
}

/**
 * An interchangeable execution backend (contract §10).
 *
 * §1 requires Aldus to support "multiple interchangeable Agent Backends, including Claude Code,
 * Codex, and API agents". Those live in adopter integrations; this is the seam they plug into.
 */
export interface AgentBackend {
  /** Identity of this backend. An open string — Core names no backend (§4.2). */
  id: string;
  /** What this backend can do. */
  capabilities(): Promise<AgentCapabilities>;
  /** Execute a request. */
  execute(request: AgentRequest): Promise<AgentResult>;
  /** Resume a paused session, where the backend supports it. */
  resume?(session: AgentSessionRef, request: AgentRequest): Promise<AgentResult>;
  /** Cancel an in-flight execution (contract §19.1). */
  cancel?(executionId: string): Promise<void>;
}

/**
 * Verify a backend offers every capability a stage requires (contract §10, §11).
 *
 * Checked *before* execution, deliberately. A stage that needs filesystem access and is handed a
 * backend without it should fail on the declaration rather than halfway through its side effects
 * — §19.1's "recovery from partial success" is a fallback for failures that could not be
 * predicted, not a substitute for the ones that could.
 *
 * @throws {AldusError} `ALDUS_STAGE_CAPABILITY_UNAVAILABLE`, naming every missing capability at
 * once. Reporting them one per run would make a misconfigured backend take several runs to
 * diagnose.
 */
export function assertCapabilities(
  capabilities: AgentCapabilities,
  required: readonly string[],
  context: { stageId: string; backendId: string },
): void {
  const offered = new Set(capabilities.offers);
  const missing = required.filter((capability) => !offered.has(capability));
  if (missing.length === 0) return;

  throw stageRunnerError(
    StageRunnerErrorCodes.STAGE_CAPABILITY_UNAVAILABLE,
    `Stage "${context.stageId}" requires capabilities the backend "${context.backendId}" does ` +
      `not offer: ${missing.join(", ")}.`,
    {
      category: "policy",
      retryable: false,
      details: { ...context, missing, offered: [...offered].sort() },
    },
  );
}

/** Describe a backend as an {@link ActorRef} for the audit record (contract §6.4, §19.2). */
export function backendActor(backend: AgentBackend, actorId: string): ActorRef {
  return { kind: "agent", id: actorId, backendId: backend.id };
}
