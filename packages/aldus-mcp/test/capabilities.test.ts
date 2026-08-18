/**
 * The §18.1 trust boundary.
 *
 * §18.1 requires read tools and mutating tools to be separate trust boundaries, and paid
 * synthesis and publishing to require explicit scoped authority. These tests pin the structure
 * that makes those statements true rather than aspirational.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CAPABILITIES, CapabilityGrant, type Capability } from "../src/capabilities.js";
import { McpErrorCodes } from "../src/errors.js";
import { MUTATION_TOOLS, READ_TOOLS, mutationTool, readTool } from "../src/tools.js";
import {
  makeSurface,
  makeTempWorkspace,
  paidStage,
  freeStage,
  type TempWorkspace,
} from "./helpers.js";

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

describe("the tool surface is split, not labelled", () => {
  it("gives every read tool exactly the read capability", () => {
    for (const tool of READ_TOOLS) {
      expect(tool.category).toBe("read");
      expect(tool.requiredCapabilities).toEqual([CAPABILITIES.read]);
    }
  });

  // A mutation with no declared authority would be broadly grantable by accident, which is the
  // failure §18.1 separates the boundaries to prevent.
  it("gives every mutating tool at least one capability", () => {
    for (const tool of MUTATION_TOOLS) {
      expect(tool.category).toBe("mutation");
      expect(tool.requiredCapabilities.length).toBeGreaterThan(0);
    }
  });

  it("never gives a read tool a mutating capability", () => {
    const mutating = new Set<string>([
      CAPABILITIES.workspaceInit,
      CAPABILITIES.runStart,
      CAPABILITIES.stageRun,
      CAPABILITIES.stageForce,
      CAPABILITIES.gateDecide,
      CAPABILITIES.spend,
      CAPABILITIES.publish,
    ]);
    for (const tool of READ_TOOLS) {
      for (const capability of tool.requiredCapabilities) {
        expect(mutating.has(capability)).toBe(false);
      }
    }
  });

  it("registers no tool name twice across the two categories", () => {
    const names = [...READ_TOOLS, ...MUTATION_TOOLS].map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // §18.1 requires publishing to need explicit scoped authority.
  //
  // This assertion previously read "there is no publishing tool", because @aldus-runtime/services
  // exposed no publishing mutation and that absence was what kept MCP off the publishing path.
  // Services now exposes one. The invariant it protected — *publishing is never reachable
  // without aldus:publish* — is unchanged; only its shape is, from "no such tool exists" to
  // "every such tool demands the capability". Deleting it would have retired the invariant
  // along with the circumstance.
  it("requires aldus:publish for every tool that reaches a release destination", () => {
    const reachesDestination = MUTATION_TOOLS.filter((tool) => /release/i.test(tool.name));

    // Guard against the filter silently matching nothing, which would make the loop vacuous.
    expect(reachesDestination.map((tool) => tool.name).sort()).toEqual([
      "aldus_execute_release",
      "aldus_reconcile_release",
    ]);

    for (const tool of reachesDestination) {
      expect(
        tool.requiredCapabilities.includes(CAPABILITIES.publish),
        `${tool.name} reaches a release destination but does not require ${CAPABILITIES.publish}`,
      ).toBe(true);
    }
  });

  // Reconciliation contacts destinations and rewrites the release record. It cannot publish, but
  // a wrong repair makes the next execution skip an operation that never happened — so it sits
  // in the publish trust domain rather than beside the read tools.
  it("keeps a read-only route to release state that needs no publish authority", () => {
    const readOnly = READ_TOOLS.filter((tool) => /release/i.test(tool.name)).map(
      (tool) => tool.name,
    );
    expect(readOnly.sort()).toEqual(["aldus_release_bundle_status", "aldus_release_status"]);
    for (const tool of READ_TOOLS) {
      expect(tool.requiredCapabilities).toEqual([CAPABILITIES.read]);
    }
  });

  // §13.2 and §18.1 name paid synthesis alongside publishing. The ledger's escape hatch for a
  // charge that already happened is included deliberately: it spends nothing, but it writes a
  // record asserting money was spent, and an agent should not be able to fabricate those freely.
  it("requires aldus:spend for every tool in the spend domain", () => {
    const spending = MUTATION_TOOLS.filter((tool) =>
      /synthesise|unauthorized_charge/i.test(tool.name),
    );
    expect(spending.map((tool) => tool.name).sort()).toEqual([
      "aldus_record_unauthorized_charge",
      "aldus_synthesise_segment",
    ]);
    for (const tool of spending) {
      expect(
        tool.requiredCapabilities.includes(CAPABILITIES.spend),
        `${tool.name} is in the spend domain but does not require ${CAPABILITIES.spend}`,
      ).toBe(true);
    }
  });

  // Recording a script or a plan spends nothing — a plan is what an operator approves, so
  // recording one is what makes authorization possible. Requiring spend authority to draft would
  // force a host to grant it to a session that only prepares work for judgement.
  it("does not require spend authority merely to record planning material", () => {
    const recording = MUTATION_TOOLS.filter((tool) =>
      /record_(performance|synthesis)/.test(tool.name),
    );
    expect(recording.map((tool) => tool.name).sort()).toEqual([
      "aldus_record_performance_script",
      "aldus_record_synthesis_plan",
    ]);
    for (const tool of recording) {
      expect(tool.requiredCapabilities).toEqual([CAPABILITIES.ttsRecord]);
    }
  });
});

describe("category types cannot be crossed", () => {
  it("refuses a read tool in the mutation list, and vice versa", () => {
    const read = READ_TOOLS[0];
    const mutation = MUTATION_TOOLS[0];
    expect(read).toBeDefined();
    expect(mutation).toBeDefined();

    // @ts-expect-error a ReadTool is not a MutationTool — it declares no capabilities and is
    // branded "read". Placing one in the mutation list would make it callable without authority.
    const asMutation: (typeof MUTATION_TOOLS)[number] = read;
    // @ts-expect-error a MutationTool is not a ReadTool; treating one as a read would drop the
    // actor §19.2 requires.
    const asRead: (typeof READ_TOOLS)[number] = mutation;

    expect(asMutation).toBeDefined();
    expect(asRead).toBeDefined();
  });

  it("refuses a hand-written literal that skips the constructors", () => {
    // @ts-expect-error the phantom brand is unforgeable outside readTool()/mutationTool(), which
    // is where capabilities and the JSON Schema are attached.
    const forged: (typeof READ_TOOLS)[number] = {
      name: "aldus_forged",
      title: "Forged",
      description: "",
      inputSchema: {},
      parse: () => ({ success: true, data: {} }),
      category: "read",
      requiredCapabilities: [CAPABILITIES.read],
      invoke: () => Promise.resolve({ outcome: "ok", data: null }),
    };
    expect(forged).toBeDefined();
  });

  it("still constructs real tools through the factories", () => {
    expect(readTool).toBeTypeOf("function");
    expect(mutationTool).toBeTypeOf("function");
  });
});

describe("CapabilityGrant", () => {
  it("holds what it was granted and nothing else", () => {
    const grant = new CapabilityGrant([CAPABILITIES.read, CAPABILITIES.gateDecide]);
    expect(grant.has(CAPABILITIES.read)).toBe(true);
    expect(grant.has(CAPABILITIES.gateDecide)).toBe(true);
    expect(grant.has(CAPABILITIES.spend)).toBe(false);
  });

  it("names the missing capability and says where authority comes from", () => {
    const grant = CapabilityGrant.readOnly();
    try {
      grant.assert([CAPABILITIES.gateDecide], "aldus_approve_gate");
      expect.unreachable("expected a capability refusal");
    } catch (error) {
      const failure = error as { code: string; retryable: boolean; message: string };
      expect(failure.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
      // Not retryable: an agent that retries with different arguments will never succeed, and
      // telling it so is what stops the loop.
      expect(failure.retryable).toBe(false);
      expect(failure.message).toMatch(/configuration/i);
    }
  });

  it("is not mutable after construction", () => {
    const granted: Capability[] = [CAPABILITIES.read];
    const grant = new CapabilityGrant(granted);
    granted.push(CAPABILITIES.spend);
    expect(grant.has(CAPABILITIES.spend)).toBe(false);
  });
});

describe("scoped authority for cost-incurring work (§18.1, §13.2)", () => {
  it("permits a free stage with only aldus:stage:run", async () => {
    const surface = makeSurface({
      root: workspace.root,
      capabilities: [CAPABILITIES.read, CAPABILITIES.stageRun, CAPABILITIES.runStart],
      stages: [freeStage()],
    });
    const result = await surface.callTool("aldus_run_stage", {
      runId: "run-a",
      stageId: "stage-free",
    });
    // The Run does not exist, so this fails for that reason — never for a missing capability.
    expect(result.error?.code).not.toBe(McpErrorCodes.CAPABILITY_REQUIRED);
  });

  it("refuses a stage that requires spend authorization without aldus:spend", async () => {
    const surface = makeSurface({
      root: workspace.root,
      capabilities: [CAPABILITIES.read, CAPABILITIES.stageRun],
      stages: [paidStage()],
    });
    const result = await surface.callTool("aldus_run_stage", {
      runId: "run-a",
      stageId: "stage-paid",
    });
    expect(result.outcome).toBe("error");
    expect(result.error?.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
    expect(result.error?.details?.["missing"]).toEqual([CAPABILITIES.spend]);
  });

  it("gets past the capability check once aldus:spend is granted", async () => {
    const surface = makeSurface({
      root: workspace.root,
      capabilities: [CAPABILITIES.read, CAPABILITIES.stageRun, CAPABILITIES.spend],
      stages: [paidStage()],
    });
    const result = await surface.callTool("aldus_run_stage", {
      runId: "run-a",
      stageId: "stage-paid",
    });
    expect(result.error?.code).not.toBe(McpErrorCodes.CAPABILITY_REQUIRED);
  });

  // Guessing "free" for a stage nobody can identify is the wrong default when the question is
  // whether money can be spent.
  it("treats an unresolvable stage as requiring spend authority", async () => {
    const surface = makeSurface({
      root: workspace.root,
      capabilities: [CAPABILITIES.read, CAPABILITIES.stageRun],
      stages: [],
    });
    const result = await surface.callTool("aldus_run_stage", {
      runId: "run-a",
      stageId: "stage-unknown",
    });
    expect(result.error?.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
    expect(result.error?.details?.["missing"]).toEqual([CAPABILITIES.spend]);
  });

  it("requires separate authority to take over a claimed stage", async () => {
    const surface = makeSurface({
      root: workspace.root,
      capabilities: [CAPABILITIES.read, CAPABILITIES.stageRun],
      stages: [freeStage()],
    });
    const result = await surface.callTool("aldus_run_stage", {
      runId: "run-a",
      stageId: "stage-free",
      force: true,
    });
    expect(result.error?.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
    expect(result.error?.details?.["missing"]).toEqual([CAPABILITIES.stageForce]);
  });

  it("applies the same rules to retry as to run", async () => {
    const surface = makeSurface({
      root: workspace.root,
      capabilities: [CAPABILITIES.read, CAPABILITIES.stageRun],
      stages: [paidStage()],
    });
    const result = await surface.callTool("aldus_retry_stage", {
      runId: "run-a",
      stageId: "stage-paid",
    });
    expect(result.error?.code).toBe(McpErrorCodes.CAPABILITY_REQUIRED);
  });
});
