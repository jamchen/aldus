/**
 * Actor identity (contract §19.2, §10.1, §3.6, §13.3).
 *
 * The failure these tests exist to prevent is a `GateDecision` that reads `kind: "human"` when
 * an agent made the call. That is not a smaller problem than an unrecorded approval — it is a
 * forged one, and nobody reviewing the record afterwards can tell.
 */

import { describe, expect, it } from "vitest";

import { AldusError } from "@aldus/core";

import { McpErrorCodes } from "../src/errors.js";
import { assertCallerIdentity, resolveActor } from "../src/identity.js";
import {
  AGENT,
  AGENT_ONLY,
  AMBIENT_OPERATOR,
  CONFIRMED_OPERATOR,
  OPERATOR_ACTOR,
} from "./helpers.js";

describe("resolveActor", () => {
  it("records the agent when no operator is configured", () => {
    const resolved = resolveActor(AGENT_ONLY);
    expect(resolved.actor.kind).toBe("agent");
    expect(resolved.actor.id).toBe(AGENT.id);
    expect(resolved.humanDecided).toBe(false);
  });

  // The centrepiece. A host that sets ALDUS_OPERATOR in config has named who is accountable for
  // the session — it has not attested that they saw this call. Recording them as the decider
  // would make every agent-initiated approval indistinguishable from a human one (§10.1).
  it("records the AGENT, not the operator, when the operator is only ambient configuration", () => {
    const resolved = resolveActor(AMBIENT_OPERATOR);
    expect(resolved.actor.kind).toBe("agent");
    expect(resolved.actor.kind).not.toBe("human");
    expect(resolved.actor.id).toBe(AGENT.id);
    expect(resolved.humanDecided).toBe(false);
  });

  it("keeps the operator visible in the recorded actor rather than dropping them", () => {
    // Attribution still matters: an operator reading trace should see whose session it was.
    const resolved = resolveActor(AMBIENT_OPERATOR);
    expect(resolved.actor.displayName).toContain("Agent A");
    expect(resolved.actor.displayName).toContain("Operator A");
  });

  it("carries the backend and session so §6.4 can say which channel it arrived on", () => {
    const resolved = resolveActor(AMBIENT_OPERATOR);
    expect(resolved.actor.backendId).toBe(AGENT.backendId);
    expect(resolved.actor.sessionRef).toBe(AGENT.sessionRef);
  });

  it("records the operator only when the host attested to per-call confirmation", () => {
    const resolved = resolveActor(CONFIRMED_OPERATOR);
    expect(resolved.actor.kind).toBe("human");
    expect(resolved.actor.id).toBe(OPERATOR_ACTOR.id);
    expect(resolved.humanDecided).toBe(true);
  });

  it("still records the agent session on a confirmed human decision", () => {
    // The human decided, but it arrived through an agent channel and trace should say so.
    const resolved = resolveActor(CONFIRMED_OPERATOR);
    expect(resolved.actor.sessionRef).toBe(AGENT.sessionRef);
    expect(resolved.actor.backendId).toBe(AGENT.backendId);
  });

  it("explains its reasoning, so an agent-attributed approval is visible in the result", () => {
    expect(resolveActor(AMBIENT_OPERATOR).rationale).toMatch(/agent is recorded as the actor/i);
    expect(resolveActor(CONFIRMED_OPERATOR).rationale).toMatch(/confirmed this specific call/i);
  });

  it("never produces a human actor from any identity lacking per-call confirmation", () => {
    // Exhaustive over the shapes a host can configure without attesting.
    for (const identity of [AGENT_ONLY, AMBIENT_OPERATOR]) {
      expect(resolveActor(identity).actor.kind).toBe("agent");
      expect(resolveActor(identity).humanDecided).toBe(false);
    }
  });
});

describe("assertCallerIdentity", () => {
  it("accepts an agent-only identity", () => {
    expect(() => assertCallerIdentity(AGENT_ONLY)).not.toThrow();
  });

  it("rejects an agent with no id", () => {
    expect(() => assertCallerIdentity({ agent: { id: "  " } })).toThrowError(AldusError);
  });

  // The operator slot names a person. Allowing an agent there would let a host wire the agent
  // into it and recover exactly the impersonation this module exists to prevent.
  it("rejects a non-human operator", () => {
    let thrown: unknown;
    try {
      assertCallerIdentity({
        agent: AGENT,
        operator: {
          actor: { kind: "agent", id: "agent-b" },
          confirmation: "per_call_confirmed",
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AldusError);
    expect((thrown as AldusError).code).toBe(McpErrorCodes.IDENTITY_INVALID);
  });

  it("rejects a malformed operator actor", () => {
    expect(() =>
      assertCallerIdentity({
        agent: AGENT,
        operator: {
          actor: { kind: "human", id: "" },
          confirmation: "ambient_configuration",
        },
      }),
    ).toThrowError(AldusError);
  });
});
