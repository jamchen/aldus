/**
 * Stage ordering in the workflow graph (contract §11; ADR-0028).
 *
 * Before edges, `WorkflowStageNode` said which gates gate a stage and nothing about what must
 * happen first. So `status` would offer a stage whose input another stage had not produced yet,
 * and `run` would perform it — which in a real pipeline meant a retimed caption file being
 * silently overwritten by the render that should have come first.
 *
 * Two properties are pinned throughout, and they are what make ordering safe to enforce where the
 * conservative *gate* fallback was not (ADR-0024):
 *
 * - an edge is **declared**, never guessed, so refusing on one cannot be the runtime overreaching;
 * - an edge **clears by running its predecessor**, which is always possible, because a graph with
 *   no runnable entry point is a cycle and is refused when the graph is resolved.
 *
 * Every test that expects a refusal also asserts the side-effect counter. An outcome alone cannot
 * prove that nothing ran.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StageDefinition, StageOutcome } from "@aldus-runtime/stage-runner";
import { z } from "zod";

import { AldusContext } from "../src/context.js";
import type { AldusServices } from "../src/services.js";
import { terminalStagesOf, validateWorkflowGraph, type WorkflowGraph } from "../src/workflow.js";

import {
  OPERATOR,
  gateDefinition,
  makeServices,
  makeTempWorkspace,
  registryOf,
  subjectsForAll,
  type TempWorkspace,
} from "./helpers.js";

const GATE = "content-freeze";

let temp: TempWorkspace;
/** Incremented by every stage here, so "did it actually run?" is answerable. */
let sideEffects: Record<string, number>;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  sideEffects = {};
});

afterEach(async () => {
  await temp.cleanup();
});

/** A stage that records having run, and can be made to fail. */
function countingStage(id: string, outcome: "succeed" | "fail" = "succeed") {
  return {
    id,
    version: "1",
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    requiredCapabilities: [],
    idempotency: { kind: "not_idempotent", reason: "stands in for irreversible work" },
    execute: (): Promise<StageOutcome<unknown>> => {
      sideEffects[id] = (sideEffects[id] ?? 0) + 1;
      if (outcome === "fail") throw new Error("the stage could not read its input");
      return Promise.resolve({ kind: "completed", output: { ran: true } });
    },
  } satisfies StageDefinition<unknown, unknown>;
}

/** The adopter's shape, with their stage names generalised: render, then retime, then check. */
const ORDERED_GRAPH: WorkflowGraph = {
  stages: [
    { stageId: "render", requiredGates: [] },
    { stageId: "retime", requiredGates: [], after: ["render"] },
    { stageId: "check", requiredGates: [], after: ["retime"] },
  ],
};

async function withRun(options: Parameters<typeof makeServices>[1]): Promise<{
  services: AldusServices;
  runId: string;
}> {
  const services = makeServices(temp.workspace, { actor: OPERATOR, ...options });
  await services.init({ episode: { showId: "example-show", slug: "episode-a" } });
  const started = await services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: "run-a",
  });
  if (started.outcome !== "ok") throw new Error("could not start a Run");
  return { services, runId: started.data.run.runId };
}

describe("an unmet predecessor stops the stage", () => {
  it("refuses, names the predecessor, and the side effect never runs", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      workflow: ORDERED_GRAPH,
    });

    const result = await services.runStage({ runId, stageId: "retime" });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("stage_predecessor_unmet");
    expect(result.refusal.explanation).toContain("render");
    expect(result.refusal.details).toMatchObject({ runId, stageId: "retime", after: ["render"] });

    // The incident this prevents: the stage running anyway and clobbering its own input.
    expect(sideEffects["retime"]).toBeUndefined();
  });

  it("is withheld by status, with the same reason run refuses on", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      workflow: ORDERED_GRAPH,
    });

    const status = await services.status(runId);
    expect(status.outcome).toBe("ok");
    if (status.outcome !== "ok") return;

    const plan = status.data.focused?.plan;
    const blocked = plan?.blocked.find(
      (action) => action.stageId === "retime" && action.kind === "run-stage",
    );
    expect(blocked?.reason).toContain("must run after");
    expect(blocked?.enforcement).toBe("enforced");

    // `render` has no predecessors, so it is the entry point and must be offered.
    expect(plan?.next.some((action) => action.stageId === "render")).toBe(true);

    const refusal = await services.runStage({ runId, stageId: "retime" });
    if (refusal.outcome !== "refused") throw new Error("expected a refusal");
    expect(refusal.refusal.explanation).toBe(blocked?.reason);
  });

  it("becomes runnable once the predecessor succeeds", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      workflow: ORDERED_GRAPH,
    });

    const first = await services.runStage({ runId, stageId: "render" });
    expect(first.outcome).toBe("ok");

    const second = await services.runStage({ runId, stageId: "retime" });
    expect(second.outcome).toBe("ok");
    expect(sideEffects["retime"]).toBe(1);
  });

  it("is not satisfied by a predecessor that failed", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render", "fail"), countingStage("retime")),
      workflow: ORDERED_GRAPH,
    });

    const first = await services.runStage({ runId, stageId: "render" });
    expect(first.outcome).toBe("unsuccessful");
    expect(sideEffects["render"]).toBe(1);

    // "Has run" is not "has succeeded": the predecessor produced nothing usable, so a dependent
    // stage reading its output would read the state the failure left behind.
    const second = await services.runStage({ runId, stageId: "retime" });
    expect(second.outcome).toBe("refused");
    expect(sideEffects["retime"]).toBeUndefined();
  });

  it("refuses a retry on the same condition", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime", "fail")),
      workflow: {
        stages: [
          { stageId: "render", requiredGates: [] },
          { stageId: "retime", requiredGates: [] },
        ],
      },
    });

    // Fail `retime` while it has no predecessor, then re-resolve the same workspace with a graph
    // that orders it after `render`. A retry must obey the edge the same way a first run does.
    const failed = await services.runStage({ runId, stageId: "retime" });
    expect(failed.outcome).toBe("unsuccessful");

    const ordered = makeServices(temp.workspace, {
      actor: OPERATOR,
      stages: registryOf(countingStage("render"), countingStage("retime", "fail")),
      workflow: ORDERED_GRAPH,
    });
    const retry = await ordered.retryStage({ runId, stageId: "retime" });

    expect(retry.outcome).toBe("refused");
    if (retry.outcome !== "refused") return;
    expect(retry.refusal.reason).toBe("stage_predecessor_unmet");
    expect(sideEffects["retime"]).toBe(1); // still just the first, failed attempt
  });

  it("cannot be bypassed with force", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      workflow: ORDERED_GRAPH,
    });

    // `force` takes over a stage a crashed runner claimed (ADR-0008). Overriding a declared data
    // dependency is a different act, and one nothing in §11 permits.
    const result = await services.runStage({ runId, stageId: "retime", force: true });

    expect(result.outcome).toBe("refused");
    expect(sideEffects["retime"]).toBeUndefined();
  });
});

describe("edges and gates are orthogonal", () => {
  const bothGraph: WorkflowGraph = {
    stages: [
      { stageId: "render", requiredGates: [] },
      { stageId: "retime", requiredGates: [GATE], after: ["render"] },
    ],
  };

  it("reports the ordering first, because running the predecessor is the step that helps", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
      workflow: bothGraph,
    });

    const result = await services.runStage({ runId, stageId: "retime" });
    if (result.outcome !== "refused") throw new Error("expected a refusal");

    // The gate may not even be decidable yet — the subjects it binds are produced by `render`.
    expect(result.refusal.reason).toBe("stage_predecessor_unmet");
  });

  it("falls through to the gate once ordering is satisfied", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
      workflow: bothGraph,
    });

    await services.runStage({ runId, stageId: "render" });
    const result = await services.runStage({ runId, stageId: "retime" });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    // Satisfying one precondition does not satisfy the other.
    expect(result.refusal.reason).toBe("stage_gate_unsatisfied");
    expect(sideEffects["retime"]).toBeUndefined();
  });

  it("runs only when both are satisfied", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
      workflow: bothGraph,
    });

    await services.runStage({ runId, stageId: "render" });
    await services.approve({ runId, gateId: GATE });
    const result = await services.runStage({ runId, stageId: "retime" });

    expect(result.outcome).toBe("ok");
    expect(sideEffects["retime"]).toBe(1);
  });

  it("does not gate a stage merely because something waits on it", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
      workflow: bothGraph,
    });

    // `render` declares no gate and no predecessor. An edge pointing *at* it must not borrow the
    // gate from the stage that waits on it — an edge is a dependency, not an authorization.
    const result = await services.runStage({ runId, stageId: "render" });
    expect(result.outcome).toBe("ok");
    expect(sideEffects["render"]).toBe(1);
  });
});

describe("a graph with no edges behaves exactly as before", () => {
  it("offers every stage, in any order", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime")),
      workflow: {
        stages: [
          { stageId: "render", requiredGates: [] },
          { stageId: "retime", requiredGates: [] },
        ],
      },
    });

    // Backward compatibility, and not optional: every 0.1.0 graph is edge-free.
    const later = await services.runStage({ runId, stageId: "retime" });
    expect(later.outcome).toBe("ok");
    expect(sideEffects["retime"]).toBe(1);
  });

  it("still leaves an undeclared stage runnable under the conservative gate fallback", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render")),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    // ADR-0024's deadlock guard. Ordering must not have quietly made the fallback enforceable.
    const result = await services.runStage({ runId, stageId: "render" });
    expect(result.outcome, "an undeclared stage must remain runnable").toBe("ok");
  });
});

describe("terminal stages", () => {
  it("are the stages nothing waits on", () => {
    expect(terminalStagesOf(ORDERED_GRAPH)).toEqual(["check"]);
  });

  it("include every parallel tail", () => {
    // A DAG can end in several places at once, which is why goals are plural (ADR-0026).
    expect(
      terminalStagesOf({
        stages: [
          { stageId: "render" },
          { stageId: "check", after: ["render"] },
          { stageId: "thumbnail", after: ["render"] },
        ],
      }),
    ).toEqual(["check", "thumbnail"]);
  });

  it("are empty for a graph with no edges, so callers fall back", () => {
    // Without edges every stage is trivially terminal, so the answer would carry no information.
    expect(terminalStagesOf({ stages: [{ stageId: "render" }, { stageId: "retime" }] })).toEqual(
      [],
    );
  });

  it("become the default goals of a Run", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime"), countingStage("check")),
      workflow: ORDERED_GRAPH,
    });

    const inspection = await services.inspect(runId);
    if (inspection.outcome !== "ok") throw new Error("expected an inspection");
    const inspected = inspection.data as { report: { run: { goalStages?: readonly string[] } } };
    expect(inspected.report.run.goalStages).toEqual(["check"]);
  });

  it("let a Run complete without every stage having run", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("render"), countingStage("retime"), countingStage("check")),
      workflow: ORDERED_GRAPH,
    });

    await services.runStage({ runId, stageId: "render" });
    await services.runStage({ runId, stageId: "retime" });
    await services.runStage({ runId, stageId: "check" });

    const status = await services.status(runId);
    if (status.outcome !== "ok") throw new Error("expected a status");
    expect(status.data.focused?.state.status).toBe("completed");
  });
});

describe("an unsatisfiable graph is refused where it is supplied", () => {
  it("names the cycle", () => {
    const problems = validateWorkflowGraph({
      stages: [
        { stageId: "render", after: ["check"] },
        { stageId: "retime", after: ["render"] },
        { stageId: "check", after: ["retime"] },
      ],
    });

    const cycle = problems.find((problem) => problem.kind === "cycle");
    expect(cycle).toBeDefined();
    // Naming the stages is the difference between an actionable error and a shrug.
    expect(cycle?.stages).toContain("render");
    expect(cycle?.message).toContain("->");
  });

  it("names an edge to a stage the graph does not contain", () => {
    const problems = validateWorkflowGraph({
      stages: [{ stageId: "retime", after: ["render"] }],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("unknown-stage");
    expect(problems[0]?.message).toContain("render");
  });

  it("names a stage declared to follow itself", () => {
    const problems = validateWorkflowGraph({ stages: [{ stageId: "render", after: ["render"] }] });
    expect(problems[0]?.kind).toBe("self-edge");
  });

  it("names a stage listed twice", () => {
    const problems = validateWorkflowGraph({
      stages: [{ stageId: "render" }, { stageId: "render" }],
    });
    expect(problems[0]?.kind).toBe("duplicate-stage");
  });

  it("accepts a graph that is merely wide", () => {
    expect(
      validateWorkflowGraph({
        stages: [
          { stageId: "render" },
          { stageId: "retime", after: ["render"] },
          { stageId: "thumbnail", after: ["render"] },
          { stageId: "check", after: ["retime", "thumbnail"] },
        ],
      }),
    ).toEqual([]);
  });

  it("throws when the context is constructed, not when a Run wedges", () => {
    expect(
      () =>
        new AldusContext({
          workspace: temp.workspace,
          workflow: { stages: [{ stageId: "retime", after: ["render"] }] },
        }),
    ).toThrowError(/workflow graph is not satisfiable/i);
  });
});
