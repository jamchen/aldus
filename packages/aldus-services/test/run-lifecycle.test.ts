/**
 * A Run's lifecycle through the service layer (ADR-0026).
 *
 * The unit rules live in `runstate.test.ts`. These prove the parts only a real workspace can
 * show: that the services report the derived state rather than the stored one, that the stored
 * one is never rewritten, that a goal the graph does not contain is refused up front, and that
 * a `1.2`-shaped manifest written before `goalStages` existed still works.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AldusError } from "@aldus-runtime/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AldusServices } from "../src/services.js";
import type { WorkflowGraph } from "../src/workflow.js";

import {
  gateDefinition,
  gatedStage,
  failingStage,
  makeServices,
  makeTempWorkspace,
  OPERATOR,
  passthroughStage,
  registryOf,
  type TempWorkspace,
} from "./helpers.js";

let workspace: TempWorkspace;

const GRAPH: WorkflowGraph = {
  stages: [{ stageId: "first" }, { stageId: "second" }],
};

beforeEach(async () => {
  workspace = await makeTempWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

/** A workspace with an Episode and the given services options. */
async function seeded(options: Parameters<typeof makeServices>[1] = {}): Promise<AldusServices> {
  const services = makeServices(workspace.workspace, { actor: OPERATOR, ...options });
  await services.init({ episode: { showId: "example-show", slug: "episode-a" } });
  return services;
}

/** Start a Run and return its id. */
async function startRun(services: AldusServices, goalStages?: readonly string[]): Promise<string> {
  const started = await services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1.0.0",
    ...(goalStages === undefined ? {} : { goalStages }),
  });
  if (started.outcome !== "ok") throw new Error("startRun refused");
  return started.data.run.runId;
}

/** Read the manifest straight off disk, bypassing every service. */
async function storedManifest(runId: string): Promise<Record<string, unknown>> {
  const path = join(workspace.workspace.layout.root, ".aldus", "runs", runId, "run.json");
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("derived status reaches the surface", () => {
  it("reports created before anything runs, and running once a stage succeeds", async () => {
    const services = await seeded({
      stages: registryOf(passthroughStage("first"), passthroughStage("second")),
      workflow: GRAPH,
    });
    const runId = await startRun(services);

    const before = await services.status(runId);
    expect(before.outcome).toBe("ok");
    if (before.outcome !== "ok") return;
    expect(before.data.focused?.state.status).toBe("created");

    await services.runStage({ runId, stageId: "first", input: {} });

    const after = await services.status(runId);
    if (after.outcome !== "ok") throw new Error("status refused");
    // One goal still outstanding, nothing in flight: a Run resting between stages.
    expect(after.data.focused?.state.status).toBe("running");
    expect(after.data.focused?.state.outstandingGoals).toEqual(["second"]);
  });

  it("reports completed once every goal has succeeded", async () => {
    const services = await seeded({
      stages: registryOf(passthroughStage("first"), passthroughStage("second")),
      workflow: GRAPH,
    });
    const runId = await startRun(services);
    await services.runStage({ runId, stageId: "first", input: {} });
    await services.runStage({ runId, stageId: "second", input: {} });

    const result = await services.status(runId);
    if (result.outcome !== "ok") throw new Error("status refused");
    expect(result.data.focused?.state.status).toBe("completed");
  });

  it("names the gate a waiting Run is held at", async () => {
    const services = await seeded({
      stages: registryOf(gatedStage("first", "content.freeze"), passthroughStage("second")),
      workflow: GRAPH,
      // Registered, because the runner now refuses an escalation to a gate nobody could decide.
      // Without it this test asserted a Run held at a gate `approve` would answer GATE_NOT_FOUND
      // for — a permanent wait dressed as a normal one (#220).
      gates: [gateDefinition("content.freeze")],
    });
    const runId = await startRun(services);
    await services.runStage({ runId, stageId: "first", input: {} });

    const result = await services.status(runId);
    if (result.outcome !== "ok") throw new Error("status refused");
    expect(result.data.focused?.state.status).toBe("waiting");
    // The whole point: "waiting" alone would send an operator hunting through the gate list.
    expect(result.data.focused?.state.waitingOn).toEqual(["content.freeze"]);
  });

  it("reports the derived status in a list of Runs, not the stored one", async () => {
    // A directory of Runs all reading `created` is the shape that misled worst.
    const services = await seeded({
      stages: registryOf(passthroughStage("first"), passthroughStage("second")),
      workflow: GRAPH,
    });
    const runId = await startRun(services);
    await services.runStage({ runId, stageId: "first", input: {} });
    await services.runStage({ runId, stageId: "second", input: {} });

    const result = await services.status();
    if (result.outcome !== "ok") throw new Error("status refused");
    const summary = result.data.runs.find((run) => run.runId === runId);
    expect(summary?.status).toBe("completed");
  });

  it("completes despite a stage that failed earlier", async () => {
    const services = await seeded({
      stages: registryOf(failingStage("first", true), passthroughStage("second")),
      workflow: GRAPH,
    });
    const runId = await startRun(services, ["second"]);
    await services.runStage({ runId, stageId: "first", input: {} });
    await services.runStage({ runId, stageId: "second", input: {} });

    const result = await services.status(runId);
    if (result.outcome !== "ok") throw new Error("status refused");
    expect(result.data.focused?.state.status).toBe("completed");
  });
});

describe("the stored manifest is never rewritten", () => {
  it("leaves status, currentStage and updatedAt exactly as created", async () => {
    const services = await seeded({
      stages: registryOf(passthroughStage("first"), passthroughStage("second")),
      workflow: GRAPH,
    });
    const runId = await startRun(services);
    const created = await storedManifest(runId);

    await services.runStage({ runId, stageId: "first", input: {} });
    await services.runStage({ runId, stageId: "second", input: {} });

    const after = await storedManifest(runId);
    // Persisting the derived value would recreate exactly the drift this fixes, and ADR-0004's
    // unknown-property preservation would carry a stale one across every future write.
    expect(after["status"]).toBe("created");
    expect(after["currentStage"]).toBeUndefined();
    expect(after["updatedAt"]).toBe(created["updatedAt"]);
  });
});

describe("goal stages", () => {
  it("defaults to every stage the graph names", async () => {
    const services = await seeded({ workflow: GRAPH });
    const runId = await startRun(services);
    expect((await storedManifest(runId))["goalStages"]).toEqual(["first", "second"]);
  });

  it("records what the Run declared instead", async () => {
    const services = await seeded({ workflow: GRAPH });
    const runId = await startRun(services, ["second"]);
    expect((await storedManifest(runId))["goalStages"]).toEqual(["second"]);
  });

  it("refuses a goal the graph does not contain, naming it", async () => {
    // A typo would otherwise produce a Run that silently never completes, with nothing to point
    // at — the same failure shape as a config key that loads and is dropped.
    const services = await seeded({ workflow: GRAPH });
    let thrown: unknown;
    try {
      await startRun(services, ["secnod"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AldusError);
    expect((thrown as AldusError).message).toContain("secnod");
    expect((thrown as AldusError).details).toMatchObject({ unknownGoalStages: ["secnod"] });
  });

  it("accepts any goal when no graph was supplied", async () => {
    // Nothing to validate against. Refusing here would block the adopters who have not adopted
    // a graph, which is precisely the set most likely to need the feature.
    const services = await seeded();
    const runId = await startRun(services, ["anything"]);
    expect((await storedManifest(runId))["goalStages"]).toEqual(["anything"]);
  });
});

describe("cancellation", () => {
  it("records who abandoned the Run and when", async () => {
    const services = await seeded({ workflow: GRAPH });
    const runId = await startRun(services);

    const result = await services.cancelRun({ runId, reason: "Superseded by a re-cut." });
    if (result.outcome !== "ok") throw new Error("cancelRun refused");

    expect(result.data.state.status).toBe("cancelled");
    expect(result.data.run.cancellation?.cancelledBy).toEqual(OPERATOR);
    expect(result.data.run.cancellation?.reason).toBe("Superseded by a re-cut.");
  });

  it("survives being read back, and is not derived away by later activity", async () => {
    const services = await seeded({
      stages: registryOf(passthroughStage("first"), passthroughStage("second")),
      workflow: GRAPH,
    });
    const runId = await startRun(services);
    await services.cancelRun({ runId });

    // A fresh services instance over the same directory: nothing in memory carries the decision.
    const reopened = makeServices(workspace.workspace, { actor: OPERATOR, workflow: GRAPH });
    const result = await reopened.status(runId);
    if (result.outcome !== "ok") throw new Error("status refused");
    expect(result.data.focused?.state.status).toBe("cancelled");
  });

  it("refuses a second cancellation rather than overwriting the first", async () => {
    // The record of who abandoned it and when is what §20's trace depends on.
    const services = await seeded({ workflow: GRAPH });
    const runId = await startRun(services);
    await services.cancelRun({ runId, reason: "first" });

    const again = await services.cancelRun({ runId, reason: "second" });
    expect(again.outcome).toBe("refused");
    if (again.outcome !== "refused") return;
    expect(again.refusal.reason).toBe("run_already_cancelled");
  });

  it("refuses without an actor, because a decision needs someone who made it", async () => {
    // §19.2 requires a mutating action to record who performed it, and §3.6 treats an
    // unattributed decision as no decision at all. Abandoning a Run is a decision.
    const services = await seeded({ workflow: GRAPH });
    const runId = await startRun(services);

    const anonymous = makeServices(workspace.workspace, { workflow: GRAPH });
    await expect(anonymous.cancelRun({ runId })).rejects.toBeInstanceOf(AldusError);
  });
});

describe("a manifest written before goalStages existed", () => {
  it("still derives a status, and defaults its goals from the graph", async () => {
    // The 1.2 shape, exactly as an adopter's stored workspace holds it. ADR-0003 promises a
    // same-major record stays readable; this is that promise against real stored data.
    const services = await seeded({
      stages: registryOf(passthroughStage("first"), passthroughStage("second")),
      workflow: GRAPH,
    });
    const runId = await startRun(services);

    await workspace.workspace.runs.update(runId, (current) => {
      const { goalStages: _dropped, ...withoutGoals } = current;
      return { ...withoutGoals, schemaVersion: "1.2" };
    });

    const stored = await storedManifest(runId);
    expect(stored["schemaVersion"]).toBe("1.2");
    expect(stored["goalStages"]).toBeUndefined();

    await services.runStage({ runId, stageId: "first", input: {} });
    await services.runStage({ runId, stageId: "second", input: {} });

    const result = await services.status(runId);
    if (result.outcome !== "ok") throw new Error("status refused");
    // Goals fall back to the graph, so the Run can still be recognised as finished.
    expect(result.data.focused?.state.status).toBe("completed");
    expect(result.data.focused?.state.goalStages).toEqual(["first", "second"]);
  });
});
