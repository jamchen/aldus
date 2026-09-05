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

import type { ActorRef } from "@aldus-runtime/core";

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
  /**
   * Whether the backend reports what it was actually charged (§19.3; #107).
   *
   * A declaration about the backend, not a budget. An adopter's current spending limit is
   * authorization and configuration; what belongs here is what the backend can *tell* you, so a
   * composition can know whether an absent cost means "nothing was charged" or "this backend
   * cannot say".
   */
  reportsActualCost?: boolean;
  /** Whether the backend reports an estimate before or alongside execution (§19.3). */
  reportsEstimatedCost?: boolean;
  /** Whether a per-execution ceiling passed to the backend is actually enforced by it (§13.2). */
  enforcesSpendCeiling?: boolean;
  /** Whether a charge can later be reconciled or looked up by provider request id (§19.3). */
  supportsCostReconciliation?: boolean;
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
  /**
   * A ceiling this execution must not exceed, where the backend enforces one (§13.2, §19.3).
   *
   * Passed only to a backend declaring `enforcesSpendCeiling`. Sending a limit to a backend that
   * ignores it would record a protection that does not exist, which is worse than no limit
   * because a reader counts it (ADR-0030).
   */
  maxSpend?: import("@aldus-runtime/core").Money;
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
  error?: import("@aldus-runtime/core").StructuredError;
  /**
   * What this execution was charged (contract §19.3; #107).
   *
   * **Plural**, because one agent execution may incur several model, provider or tool charges,
   * possibly in different units or currencies. A single `cost` would force a backend that knows
   * three amounts to report one and discard the rest.
   *
   * **Reportable on a failed result as well as a successful one.** A provider may charge for a
   * request that ultimately fails, and a cost channel that survived only success would lose
   * exactly the spend an operator most needs to see.
   *
   * Billing facts only. The Runtime states which Run, Stage, attempt and authorization a charge
   * belongs to — asking each backend to remember to copy an `authorizationId` is the silent
   * budget-bypass class #107 reported.
   */
  costs?: readonly import("@aldus-runtime/core").CostObservation[];
  /**
   * The backend's own statement that it never dispatched anything (§13.2, §19.3; #283).
   *
   * **A declaration, never an inference.** Absent — the default — a failure means what it has
   * always meant: the request may have been billed and nobody can say, so the reservation stays
   * committed. `false` is a backend asserting the opposite about *this* call: it refused before
   * spawning, so no provider was reached and no charge can exist.
   *
   * Only `false` carries meaning. `true` is accepted and says nothing the ordinary path does not
   * already assume.
   *
   * It is the same trust `billingStatus: "free"` already receives — a backend stating a billing
   * fact the runtime cannot observe — narrowed to the one fact a refusing backend actually knows.
   * A backend that declares this and *did* spawn releases authorization for money that is gone,
   * which is why the runtime never derives it from a failure, an exit code, or a message.
   *
   * Measured: an execution refused by an adopter-side ceiling printed "nothing was spawned" and
   * left a reservation holding its full reserved amount as `billing_unknown`, which then refused
   * every later dispatch on the grant. The backend knew; it had no way to say so.
   */
  dispatched?: boolean;
}

/**
 * A marker carried on an error a backend throws when it refused **before** dispatching (#283).
 *
 * The thrown half of {@link AgentResult.dispatched}. A backend that refuses by throwing — the
 * common shape — wraps its reason with this, and the runtime releases the reservation instead of
 * retaining it as an unknown charge.
 *
 * A symbol rather than a message pattern or an error subclass: a message is a description that
 * drifts, and a subclass forces a backend to import a base class to say one fact.
 */
const UNDISPATCHED = Symbol.for("aldus.undispatched");

/**
 * Declare that a refusal happened before anything was dispatched (§19.3; #283).
 *
 * `throw undispatched("the workspace ceiling is already exceeded, so nothing was spawned")`.
 * The reason is recorded on the released reservation, so the trace answers why authorization
 * stopped being committed without a charge (§20).
 *
 * Wraps an existing error when one is passed, so a backend keeps its own failure shape.
 */
export function undispatched(reason: string, cause?: unknown): Error {
  const error = new Error(reason, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, UNDISPATCHED, { value: reason, enumerable: false });
  return error;
}

/**
 * The declared reason a thrown failure never dispatched, or `undefined` (§19.3; #283).
 *
 * `undefined` for **every** error that did not declare it, including one whose message says so in
 * words. Reading a refusal out of prose is how a failure that did spend money releases its
 * reservation.
 */
export function undispatchedReason(thrown: unknown): string | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;
  const declared = (thrown as Record<symbol, unknown>)[UNDISPATCHED];
  return typeof declared === "string" && declared.trim() !== "" ? declared : undefined;
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
  /**
   * Version of this backend, resolved exactly — never "latest" (§20; ADR-0044).
   *
   * Required because a spend reservation records **which version was dispatched under an enforced
   * ceiling**, and that evidence must not be reconstructed by re-reading today's capabilities. A
   * backend that enforces a ceiling now says nothing about a request an earlier version made, and
   * inferring the second from the first is claiming a protection from a declaration that was not
   * the one in force.
   *
   * The same rule `Worker.version` follows, for the same reason.
   */
  version: string;
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
