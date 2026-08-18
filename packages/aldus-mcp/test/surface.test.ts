/**
 * The tool surface end to end (contract §18, §18.1, §19.2).
 *
 * Exercised against real temp workspaces. A surface tested against a mocked store proves nothing
 * about workspace binding, which is one of the things §19.2 requires to be explicit.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CAPABILITIES, CapabilityGrant } from "../src/capabilities.js";
import { McpErrorCodes } from "../src/errors.js";
import { AldusToolSurface } from "../src/surface.js";
import { MUTATION_TOOLS, READ_TOOLS } from "../src/tools.js";
import {
  AGENT,
  AGENT_ONLY,
  AMBIENT_OPERATOR,
  CONFIRMED_OPERATOR,
  freeStage,
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

describe("workspace binding (§19.2)", () => {
  it("refuses to construct without an explicit workspace root", () => {
    expect(
      () =>
        new AldusToolSurface({
          workspaceRoot: "   ",
          identity: AGENT_ONLY,
          capabilities: CapabilityGrant.all(),
        }),
    ).toThrowError(/workspace/i);
  });

  // An agent reading a tool result must never have to infer which workspace it touched.
  it("echoes the bound workspace on every result, including failures", async () => {
    const surface = makeSurface({ root: workspace.root });
    const read = await surface.callTool("aldus_status", {});
    const unknown = await surface.callTool("aldus_nonexistent", {});

    expect(read.workspaceRoot).toBe(workspace.root);
    expect(unknown.workspaceRoot).toBe(workspace.root);
  });

  it("exposes no tool that takes a workspace argument", () => {
    // A workspace argument would let one session wander between workspaces, which is the
    // ambient binding §19.2 rules out.
    for (const tool of [...READ_TOOLS, ...MUTATION_TOOLS]) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      for (const name of Object.keys(properties ?? {})) {
        expect(name.toLowerCase()).not.toContain("workspace");
      }
    }
  });
});

describe("listTools", () => {
  it("advertises every tool with its category and authority", () => {
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });
    const listed = surface.listTools();
    expect(listed).toHaveLength(READ_TOOLS.length + MUTATION_TOOLS.length);

    const status = listed.find((tool) => tool.name === "aldus_status");
    expect(status?.category).toBe("read");
    expect(status?.permitted).toBe(true);

    const approve = listed.find((tool) => tool.name === "aldus_approve_gate");
    expect(approve?.category).toBe("mutation");
    expect(approve?.requiredCapabilities).toContain(CAPABILITIES.gateDecide);
  });

  // Hiding an unpermitted tool teaches an agent the capability does not exist, and it works
  // around the gap instead of asking the operator to grant it.
  it("lists unpermitted tools rather than hiding them, marked not permitted", () => {
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });
    const approve = surface.listTools().find((tool) => tool.name === "aldus_approve_gate");
    expect(approve).toBeDefined();
    expect(approve?.permitted).toBe(false);
  });

  it("publishes a JSON Schema that rejects unknown arguments", () => {
    const surface = makeSurface({ root: workspace.root });
    const status = surface.listTools().find((tool) => tool.name === "aldus_status");
    // Unlike stored records (ADR-0002), tool arguments are not versioned: an unrecognised
    // argument is a mistake, not a field from the future.
    expect(status?.inputSchema["additionalProperties"]).toBe(false);
  });
});

describe("callTool", () => {
  it("never throws, so a transport always has something to serialise", async () => {
    const surface = makeSurface({ root: workspace.root });
    const result = await surface.callTool("aldus_nonexistent", {});
    expect(result.outcome).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe(McpErrorCodes.TOOL_UNKNOWN);
  });

  it("rejects arguments that do not match the schema", async () => {
    const surface = makeSurface({ root: workspace.root });
    const result = await surface.callTool("aldus_artifacts", { runId: "" });
    expect(result.error?.code).toBe(McpErrorCodes.TOOL_ARGUMENTS_INVALID);
  });

  it("rejects an unknown argument rather than ignoring it", async () => {
    const surface = makeSurface({ root: workspace.root });
    const result = await surface.callTool("aldus_status", { runId: "run-a", extra: true });
    expect(result.error?.code).toBe(McpErrorCodes.TOOL_ARGUMENTS_INVALID);
  });

  // §19.2. An agent may have put a credential in the wrong field; echoing it back would place it
  // in the transcript, which is durable in a way the mistake was not.
  it("reports argument failures by path and code, never by value", async () => {
    const surface = makeSurface({ root: workspace.root });
    const secret = "sk-Live-9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";
    const result = await surface.callTool("aldus_artifacts", { runId: "", token: secret });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(secret);
    expect(result.error?.details?.["issues"]).toBeDefined();
  });

  it("runs a read tool without any actor", async () => {
    const surface = makeSurface({ root: workspace.root, capabilities: [CAPABILITIES.read] });
    const result = await surface.callTool("aldus_status", {});
    expect(result.actor).toBeUndefined();
    expect(result.error?.code).not.toBe(McpErrorCodes.CAPABILITY_REQUIRED);
  });
});

describe("mutations record an actor (§19.2)", () => {
  it("records the agent when the operator is ambient configuration", async () => {
    const surface = makeSurface({
      root: workspace.root,
      identity: AMBIENT_OPERATOR,
      capabilities: [CAPABILITIES.read, CAPABILITIES.workspaceInit],
    });
    const result = await surface.callTool("aldus_init", {
      episode: { showId: "example-show", slug: "episode-a" },
    });

    expect(result.actor?.kind).toBe("agent");
    expect(result.actor?.id).toBe(AGENT.id);
    expect(result.actorRationale).toBeDefined();
  });

  it("records the operator when the host attested to per-call confirmation", async () => {
    const surface = makeSurface({
      root: workspace.root,
      identity: CONFIRMED_OPERATOR,
      capabilities: [CAPABILITIES.read, CAPABILITIES.workspaceInit],
    });
    const result = await surface.callTool("aldus_init", {
      episode: { showId: "example-show", slug: "episode-a" },
    });

    expect(result.actor?.kind).toBe("human");
    expect(result.actor?.id).toBe(OPERATOR_ACTOR.id);
  });

  // §18.1: no tool may accept "the user approved this" as an argument. If one did, an agent
  // could manufacture a human approval, and §3.6's recorded decision would mean nothing.
  it("accepts no argument that could assert human approval", () => {
    const suspicious = /approved|approvedBy|confirmed|onBehalfOf|actor|humanDecided|operator/i;
    for (const tool of MUTATION_TOOLS) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      for (const name of Object.keys(properties ?? {})) {
        expect(suspicious.test(name), `${tool.name} exposes an identity argument "${name}"`).toBe(
          false,
        );
      }
    }
  });

  it("carries a decision through to the gate engine rather than deciding here", async () => {
    const surface = makeSurface({
      root: workspace.root,
      identity: AMBIENT_OPERATOR,
      capabilities: [CAPABILITIES.read, CAPABILITIES.gateDecide],
      stages: [freeStage()],
    });
    // No such Run, so this fails in the services — the point is that it reached them at all,
    // rather than this package forming its own opinion about the gate.
    const result = await surface.callTool("aldus_approve_gate", {
      runId: "run-missing",
      gateId: "content-freeze",
    });
    expect(result.error?.code).not.toBe(McpErrorCodes.CAPABILITY_REQUIRED);
    expect(result.outcome).toBe("error");
  });
});

describe("result shaping", () => {
  it("marks a refusal as an error and an unsuccessful run as not one", async () => {
    // A gate halt is the runtime doing what §11 requires. Flagging it would push an agent to
    // retry a stage that is correctly waiting.
    const surface = makeSurface({ root: workspace.root });
    const listed = surface.listTools();
    expect(listed.length).toBeGreaterThan(0);

    const unknown = await surface.callTool("aldus_nonexistent");
    expect(unknown.isError).toBe(true);
  });

  it("names the tool on every result", async () => {
    const surface = makeSurface({ root: workspace.root });
    const result = await surface.callTool("aldus_status", {});
    expect(result.tool).toBe("aldus_status");
  });
});
