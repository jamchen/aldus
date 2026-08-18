/**
 * The tools that spend money and publish (contract §10.1, §13.2, §17, §18.1).
 *
 * `aldus_synthesise_segment` incurs provider cost and `aldus_execute_release` reaches external
 * destinations. They are the two calls where §10.1's rules stop being principles and start
 * being the difference between a bill an operator approved and one they did not.
 *
 * Every test here is written as an attempted bypass rather than a happy path with an assertion
 * appended: the question is not "does it work when everything is granted", it is "can it be made
 * to work when something is missing".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { takeDecisionSchema } from "@aldus-runtime/tts-ledger";
import { z } from "zod";

import { CAPABILITIES } from "../src/capabilities.js";
import { McpErrorCodes } from "../src/errors.js";
import { MUTATION_TOOLS, READ_TOOLS } from "../src/tools.js";
import {
  AGENT,
  AMBIENT_OPERATOR,
  makeSurface,
  makeTempWorkspace,
  OPERATOR_ACTOR,
  type TempWorkspace,
} from "./helpers.js";

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

/** A syntactically valid bundle. Destinations are caller-supplied names (§4.2). */
function bundleArgs() {
  return {
    bundleId: "bundle-a",
    runId: "run-a",
    episodeId: "show:example-show:episode:episode-a",
    required: [
      {
        operationId: "operation-a",
        kind: "kind-a",
        destination: "destination-a",
        inputHashes: ["a".repeat(64)],
        requiresAuthority: "release.upload",
      },
    ],
    bestEffort: [],
  };
}

/** A syntactically valid plan. Provider, voice, and model are opaque strings (§4.2). */
function planArgs() {
  return {
    schemaVersion: "1.2",
    planId: "plan-a",
    runId: "run-a",
    scriptId: "script-a",
    scriptSha256: "b".repeat(64),
    parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
    segments: [{ segmentId: "segment-a", text: { raw: "Some spoken words." } }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("the fixtures are valid, so refusals are about authority", () => {
  // Arguments are parsed before authority is consulted. A malformed fixture would report
  // ALDUS_MCP_TOOL_ARGUMENTS_INVALID and every capability assertion below would be passing for
  // the wrong reason.
  it("parses against the real tool schemas", () => {
    const byName = new Map(MUTATION_TOOLS.map((tool) => [tool.name, tool]));

    const plan = byName.get("aldus_synthesise_segment")?.parse({
      plan: planArgs(),
      segmentId: "segment-a",
    });
    expect(plan?.success, "the plan fixture does not satisfy ttsRequestPlanSchema").toBe(true);

    const bundle = byName.get("aldus_execute_release")?.parse({ bundle: bundleArgs() });
    expect(bundle?.success, "the bundle fixture does not satisfy the bundle schema").toBe(true);
  });
});

describe("no tool accepts an approval or an identity (§10.1, §18.1)", () => {
  // §3.6: a decision counts only when it is recorded and tied to exact inputs. An argument
  // asserting one would make the agent's word the audit trail, which §10.1 forbids outright.
  it("declares no argument that could assert an approval or an actor", () => {
    const forbidden =
      /(^|[^a-z])(approved|approval|authorized|authorised|actor|identity|operator|human|confirmed|capabilit)/i;

    for (const tool of [...READ_TOOLS, ...MUTATION_TOOLS]) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const property of properties) {
        expect(
          forbidden.test(property),
          `${tool.name} declares an argument "${property}" that could stand in for authority`,
        ).toBe(false);
      }
    }
  });

  it("keeps the dangerous tools on the mutation boundary, never among the reads", () => {
    const readNames = READ_TOOLS.map((tool) => tool.name);
    expect(readNames).not.toContain("aldus_synthesise_segment");
    expect(readNames).not.toContain("aldus_execute_release");
    expect(readNames).not.toContain("aldus_reconcile_release");
  });

  it("says plainly in its description that it costs money or publishes", () => {
    // An agent decides whether to call a tool from its description. Burying the consequence
    // there is how an agent ends up spending money it did not mean to.
    const byName = new Map(MUTATION_TOOLS.map((tool) => [tool.name, tool]));
    expect(byName.get("aldus_synthesise_segment")?.description).toMatch(/COSTS MONEY/);
    expect(byName.get("aldus_execute_release")?.description).toMatch(/PUBLISHES/);
  });
});

describe("synthesis cannot be reached without authority (§13.2, §18.1)", () => {
  it("refuses without aldus:spend, whatever else the session holds", async () => {
    const surface = makeSurface({
      root: workspace.root,
      // Everything except the one capability that matters here.
      capabilities: [
        CAPABILITIES.read,
        CAPABILITIES.gateDecide,
        CAPABILITIES.ttsRecord,
        CAPABILITIES.publish,
      ],
    });

    const result = await surface.callTool("aldus_synthesise_segment", {
      plan: planArgs(),
      segmentId: "segment-a",
    });

    expect(result.outcome).toBe("error");
    expect(result.error?.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
    // Non-retryable: an agent told only "not permitted" will try different arguments forever.
    expect(result.error?.retryable).toBe(false);
    expect(JSON.stringify(result.error?.details)).toContain(CAPABILITIES.spend);
  });

  it("cannot be granted spend authority through an argument", async () => {
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });

    const result = await surface.callTool("aldus_synthesise_segment", {
      plan: planArgs(),
      segmentId: "segment-a",
      // A plausible-looking escalation attempt. The schema rejects unknown arguments, so this
      // fails before authority is even consulted.
      capabilities: [CAPABILITIES.spend],
    });

    expect(result.outcome).toBe("error");
    expect(result.error?.code).toBe(McpErrorCodes.TOOL_ARGUMENTS_INVALID);
  });

  it("holding aldus:spend still does not reach a provider without an adapter", async () => {
    // ADR-0015: the adapter is the adopter's to supply, and no authority an operator grants
    // conjures one. The distinction matters because an agent must not read this as a refusal it
    // can resolve by asking for more capability.
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.spend] });

    const result = await surface.callTool("aldus_synthesise_segment", {
      plan: planArgs(),
      segmentId: "segment-a",
    });

    expect(result.outcome).toBe("error");
    expect(result.isError).toBe(true);
  });
});

describe("publishing cannot be reached without authority (§17, §18.1)", () => {
  it("refuses to execute a release without aldus:publish", async () => {
    const surface = makeSurface({
      root: workspace.root,
      capabilities: [CAPABILITIES.read, CAPABILITIES.spend, CAPABILITIES.gateDecide],
    });

    const result = await surface.callTool("aldus_execute_release", { bundle: bundleArgs() });

    expect(result.outcome).toBe("error");
    expect(result.error?.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
    expect(JSON.stringify(result.error?.details)).toContain(CAPABILITIES.publish);
  });

  it("refuses to reconcile a release without aldus:publish", async () => {
    // Reconciliation publishes nothing, but it contacts destinations and rewrites the release
    // record. A wrong repair makes the next execution skip an operation that never happened.
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });

    const result = await surface.callTool("aldus_reconcile_release", { bundle: bundleArgs() });

    expect(result.outcome).toBe("error");
    expect(result.error?.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
  });

  it("leaves a read-only route to release state that needs no publish authority", async () => {
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });

    const result = await surface.callTool("aldus_release_bundle_status", { bundle: bundleArgs() });

    // The Run does not exist in this fresh workspace, so this fails on the Run rather than on
    // authority — which is the point: the capability check let it through.
    expect(result.error?.code).not.toBe(McpErrorCodes.CAPABILITY_REQUIRED);
  });
});

describe("artifact custody needs its own authority (§8.1)", () => {
  it("refuses to archive without aldus:artifact:archive", async () => {
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });

    const result = await surface.callTool("aldus_archive_irreplaceable", { runId: "run-a" });

    expect(result.outcome).toBe("error");
    expect(result.error?.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
    expect(JSON.stringify(result.error?.details)).toContain(CAPABILITIES.artifactArchive);
  });

  it("lets a read-only session plan a cleanup without being able to perform one", async () => {
    // §8.1 makes archival the thing that decides whether a cleanup is safe. Seeing that is a
    // read; acting on it is not.
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });

    const plan = await surface.callTool("aldus_plan_artifact_cleanup", { runId: "run-a" });
    expect(plan.error?.code).not.toBe(McpErrorCodes.CAPABILITY_REQUIRED);
  });
});

describe("the recorded actor stays the agent (§10.1, ADR-0014 §4)", () => {
  // The rule matters most on exactly these tools: a spend or a release attributed to a human
  // who never saw the call is a forged record, and nobody reviewing it later can tell.
  it("records the agent for a release attempt, even with an operator configured", async () => {
    const surface = makeSurface({
      root: workspace.root,
      identity: AMBIENT_OPERATOR,
      capabilities: [CAPABILITIES.publish],
    });

    const result = await surface.callTool("aldus_execute_release", { bundle: bundleArgs() });

    expect(result.actor?.kind).toBe("agent");
    expect(result.actor?.id).toBe(AGENT.id);
    expect(result.actor?.id).not.toBe(OPERATOR_ACTOR.id);
    expect(result.actorRationale).toBeDefined();
  });

  it("records the agent for a take decision, which §13.3 keeps human-owned", async () => {
    const surface = makeSurface({
      root: workspace.root,
      identity: AMBIENT_OPERATOR,
      capabilities: [CAPABILITIES.gateDecide],
    });

    const result = await surface.callTool("aldus_decide_take", {
      runId: "run-a",
      takeId: "take-a",
      decision: { decision: "accepted", decidedAt: "2026-01-01T00:00:00.000Z" },
    });

    expect(result.actor?.kind).toBe("agent");
    expect(result.actor?.id).toBe(AGENT.id);
  });

  // The ledger takes `decidedBy` as a caller-supplied string, which is right in the ledger: it
  // records what it is told and the gate engine enforces permittedActorKinds. Across this
  // boundary it is the argument §10.1 forbids — an agent naming a human as the decider of a
  // judgement §13.3 keeps human-owned, undetectable to whoever reads the ledger later.
  it("does not let a caller name who decided a take", () => {
    const tool = MUTATION_TOOLS.find((entry) => entry.name === "aldus_decide_take");
    expect(tool).toBeDefined();

    const decision = (
      (
        tool?.inputSchema as {
          properties?: Record<string, { properties?: Record<string, unknown> }>;
        }
      ).properties ?? {}
    ).decision;
    expect(Object.keys(decision?.properties ?? {})).not.toContain("decidedBy");

    // And it is rejected rather than ignored, so an agent that tries learns it cannot.
    const parsed = tool?.parse({
      runId: "run-a",
      takeId: "take-a",
      decision: {
        decision: "accepted",
        decidedBy: "operator-a",
        decidedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(parsed?.success).toBe(false);
  });

  // The tool restates the decision fields rather than deriving them, because Zod refuses
  // `.omit()` on a schema carrying refinements. Restating means the two can drift, so this is
  // the test that stops it: a field added to the ledger's decision and forgotten here would
  // silently stop being accepted over MCP.
  it("accepts exactly the ledger's decision fields, less decidedBy", () => {
    const ledgerFields = Object.keys(
      (
        z.toJSONSchema(takeDecisionSchema, { target: "draft-2020-12" }) as {
          properties?: Record<string, unknown>;
        }
      ).properties ?? {},
    ).filter((field) => field !== "decidedBy");

    const tool = MUTATION_TOOLS.find((entry) => entry.name === "aldus_decide_take");
    const decision = (
      (
        tool?.inputSchema as {
          properties?: Record<string, { properties?: Record<string, unknown> }>;
        }
      ).properties ?? {}
    ).decision;
    const toolFields = Object.keys(decision?.properties ?? {});

    expect(ledgerFields.length).toBeGreaterThan(0);
    expect(toolFields.sort()).toEqual(ledgerFields.sort());
  });

  // Omitting a field from a refined schema is the kind of edit that quietly drops the refinement
  // with it. §15 requires a rejection to carry a reason, because one that does not cannot become
  // a repair strategy or a regression case.
  it("still requires a reason for a rejection", () => {
    const tool = MUTATION_TOOLS.find((entry) => entry.name === "aldus_decide_take");

    const withoutReason = tool?.parse({
      runId: "run-a",
      takeId: "take-a",
      decision: { decision: "rejected", decidedAt: "2026-01-01T00:00:00.000Z" },
    });
    const withReason = tool?.parse({
      runId: "run-a",
      takeId: "take-a",
      decision: {
        decision: "rejected",
        decidedAt: "2026-01-01T00:00:00.000Z",
        reason: "Audible clipping in the second phrase.",
      },
    });

    expect(withoutReason?.success, "a reasonless rejection was accepted").toBe(false);
    expect(withReason?.success).toBe(true);
  });
});

describe("unpermitted tools stay visible (§18.1)", () => {
  it("lists the dangerous tools as unpermitted rather than hiding them", () => {
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });
    const listed = surface.listTools();
    const names = listed.map((tool) => tool.name);

    // An agent that cannot see a tool concludes the capability does not exist and works around
    // it. One that sees it is unauthorized asks the operator to grant it.
    expect(names).toContain("aldus_synthesise_segment");
    expect(names).toContain("aldus_execute_release");

    for (const name of ["aldus_synthesise_segment", "aldus_execute_release"]) {
      const tool = listed.find((entry) => entry.name === name);
      expect(tool?.permitted, `${name} should be listed as unpermitted`).toBe(false);
      expect(tool?.requiredCapabilities.length).toBeGreaterThan(0);
    }
  });
});
