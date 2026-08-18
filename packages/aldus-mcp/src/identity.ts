/**
 * Caller identity — who a mutation is recorded against (contract §19.2, §10.1, §3.6).
 *
 * This is the sharpest decision in the package, because getting it wrong produces a record that
 * is worse than no record. §19.2 requires mutating actions to record actor identity. §3.6 says a
 * human decision only counts once "translated into a recorded decision tied to exact inputs".
 * And §10.1 states plainly that Claude Code MUST NOT be "relied on to remember approvals across
 * sessions".
 *
 * Put together, the failure to avoid is specific: a `GateDecision` that reads as
 * `kind: "human"` when an agent is what actually called the tool. Nobody reviewing that record
 * later can tell whether a person decided. It is not a smaller problem than an unrecorded
 * approval — it is a *forged* one, and §13.3 keeps final performance approval human-owned
 * precisely so that cannot happen.
 *
 * The constraint that follows: **the server cannot verify that a human decided.** An MCP server
 * receives a tool call. It does not see the conversation, cannot tell whether the operator read
 * what they were approving, and must not take the agent's word for it — §18.1 is explicit that
 * no tool may accept "the user approved this" as an argument.
 *
 * So identity is resolved from **how the host configured the session**, not from arguments, and
 * the default is honest rather than convenient:
 *
 * - `ambient_configuration` — the host set an operator identity in config. That names who is
 *   accountable for the session, not who decided this call. The recorded actor is the **agent**,
 *   with the operator visible in `displayName`.
 * - `per_call_confirmed` — the host has out-of-band evidence that the human confirmed *this*
 *   call. Only then is the operator the actor, and the agent session is still recorded in
 *   `sessionRef` so the channel stays visible.
 *
 * Ambient is the default because it is the common case and the safe one. A host that genuinely
 * confirms per call has to say so deliberately.
 */

import { validate, type ActorRef } from "@aldus/core";

import { McpErrorCodes, mcpError } from "./errors.js";

/**
 * How much the host knows about the operator's involvement in a given call.
 *
 * The distinction exists because these are different facts, and collapsing them is what
 * produces a forged approval.
 */
export const OPERATOR_CONFIRMATIONS = [
  /**
   * The operator identity comes from configuration. It names who is accountable for the
   * session; it does not attest that they saw this call.
   */
  "ambient_configuration",
  /**
   * The host has out-of-band evidence that this human confirmed this specific call — an
   * elicitation round-trip, a signed confirmation, an interactive prompt the agent cannot forge.
   */
  "per_call_confirmed",
] as const;

/** @see OPERATOR_CONFIRMATIONS */
export type OperatorConfirmation = (typeof OPERATOR_CONFIRMATIONS)[number];

/** The agent session behind a tool call (contract §10). */
export interface AgentIdentity {
  /** Stable identifier for the agent. */
  id: string;
  /** Human-readable name, for an operator reading production trace (§20). */
  displayName?: string;
  /** Agent Backend that is running (contract §10 `AgentBackend.id`). Opaque to Core (§4.2). */
  backendId?: string;
  /** Session reference (contract §10 `AgentSessionRef`). Never authoritative state (§3.4). */
  sessionRef?: string;
}

/** The human accountable for the session, and how much the host actually knows. */
export interface OperatorIdentity {
  /** Must be a `human` actor: this slot exists to name a person. */
  actor: ActorRef;
  /** What the host can attest to. @see OPERATOR_CONFIRMATIONS */
  confirmation: OperatorConfirmation;
}

/** Who is behind a tool call. */
export interface CallerIdentity {
  /**
   * The agent session. Always present — an MCP tool call always arrives through one, and
   * pretending otherwise is how the agent's involvement disappears from the record.
   */
  agent: AgentIdentity;
  /** The operator, when the host knows one. */
  operator?: OperatorIdentity;
}

/** How an actor was arrived at, reported alongside every mutation result. */
export interface ResolvedActor {
  /** What gets recorded (contract §19.2). */
  actor: ActorRef;
  /**
   * Why this actor and not another.
   *
   * Returned so a host — or an operator reading a tool result — can see that an approval was
   * attributed to an agent, rather than discovering it later in the event log.
   */
  rationale: string;
  /** Whether a human is recorded as the decider. */
  humanDecided: boolean;
}

/**
 * Validate a caller identity at construction time.
 *
 * @throws {AldusError} `ALDUS_MCP_IDENTITY_INVALID`
 */
export function assertCallerIdentity(identity: CallerIdentity): void {
  if (identity.agent.id.trim().length === 0) {
    throw mcpError(
      McpErrorCodes.IDENTITY_INVALID,
      "The agent identity needs a non-empty id. Every MCP tool call arrives through an agent " +
        "session, and an unidentified one cannot be recorded against a mutation (§19.2).",
      { category: "validation" },
    );
  }

  const operator = identity.operator;
  if (operator === undefined) return;

  const result = validate("ActorRef", operator.actor);
  if (!result.ok) {
    throw mcpError(
      McpErrorCodes.IDENTITY_INVALID,
      "The operator identity is not a valid ActorRef.",
      { category: "validation", details: { issues: result.error.details } },
    );
  }

  if (operator.actor.kind !== "human") {
    throw mcpError(
      McpErrorCodes.IDENTITY_INVALID,
      `The operator identity has kind "${operator.actor.kind}", but the operator slot names the ` +
        "person accountable for the session. Recording a non-human there would make " +
        '"was this decided by a person?" unanswerable, which is the question §13.3 and §3.6 ' +
        "exist to keep answerable.",
      { category: "validation", details: { kind: operator.actor.kind } },
    );
  }
}

/**
 * Decide the actor a mutation is recorded against (contract §19.2, §10.1).
 *
 * Returns an agent actor unless the host has attested to per-call human confirmation. See the
 * module comment for why that default is the safe one.
 */
export function resolveActor(identity: CallerIdentity): ResolvedActor {
  const { agent, operator } = identity;

  if (operator !== undefined && operator.confirmation === "per_call_confirmed") {
    // The human decided and the host can attest to it. The session is still recorded, so trace
    // shows the decision arrived through an agent channel rather than a terminal (§6.4).
    const actor: ActorRef = {
      ...operator.actor,
      ...(agent.backendId !== undefined ? { backendId: agent.backendId } : {}),
      ...(agent.sessionRef !== undefined ? { sessionRef: agent.sessionRef } : {}),
    };
    return {
      actor,
      humanDecided: true,
      rationale:
        "The host attested that this operator confirmed this specific call, so the operator is " +
        "recorded as the actor. The agent session is retained so the channel stays visible.",
    };
  }

  const onBehalfOf = operator?.actor.displayName ?? operator?.actor.id;
  const agentName = agent.displayName ?? agent.id;

  const actor: ActorRef = {
    kind: "agent",
    id: agent.id,
    displayName: onBehalfOf === undefined ? agentName : `${agentName} (on behalf of ${onBehalfOf})`,
    ...(agent.backendId !== undefined ? { backendId: agent.backendId } : {}),
    ...(agent.sessionRef !== undefined ? { sessionRef: agent.sessionRef } : {}),
  };

  return {
    actor,
    humanDecided: false,
    rationale:
      operator === undefined
        ? "No operator is configured for this session, so the agent is recorded as the actor."
        : "The configured operator is ambient session context, not an attestation that they saw " +
          "this call, so the agent is recorded as the actor and the operator appears as the " +
          "party it acted for. Recording the operator as the decider would make an agent's " +
          "decision read as a human's (§10.1, §13.3).",
  };
}
