/**
 * Deriving a Run's state (ADR-0026).
 *
 * `deriveRunState` is a pure function, so these exercise the rules directly against hand-built
 * snapshots rather than through a workspace. The integration side — that the services actually
 * report the derived value, and never write it back — lives in `services.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { deriveRunState, goalStagesFor } from "../src/runstate.js";
import type { StageSnapshot } from "../src/nextaction.js";
import type { WorkflowGraph } from "../src/workflow.js";

/** A stage snapshot with only the fields the derivation reads. */
function stage(stageId: string, status: StageSnapshot["status"], gateId?: string): StageSnapshot {
  return { stageId, status, ...(gateId === undefined ? {} : { gateId }) };
}

const graph: WorkflowGraph = {
  stages: [{ stageId: "first" }, { stageId: "second" }],
};

describe("goalStagesFor", () => {
  it("prefers what the Run declared", () => {
    expect(goalStagesFor({ goalStages: ["second"] }, graph)).toEqual(["second"]);
  });

  it("falls back to every stage the graph names", () => {
    expect(goalStagesFor({}, graph)).toEqual(["first", "second"]);
  });

  it("has no goals without a graph or a declaration", () => {
    // Honest rather than convenient: nothing has said what finishing would mean.
    expect(goalStagesFor({}, undefined)).toEqual([]);
  });

  it("respects an explicit empty declaration", () => {
    // Distinct from absent: the Run said it intends to reach nothing in particular.
    expect(goalStagesFor({ goalStages: [] }, graph)).toEqual([]);
  });
});

describe("deriveRunState", () => {
  it("reports created before anything has run", () => {
    const state = deriveRunState({}, [stage("first", "never_run")], graph);
    expect(state.status).toBe("created");
  });

  it("reports running while a stage is in flight", () => {
    const state = deriveRunState({}, [stage("first", "running")], graph);
    expect(state.status).toBe("running");
    expect(state.currentStage).toBe("first");
  });

  it("reports waiting when a stage halted at a gate, and names the gate", () => {
    const state = deriveRunState({}, [stage("first", "waiting_for_gate", "content.freeze")], graph);
    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toEqual(["content.freeze"]);
  });

  it("names every gate when several stages are halted", () => {
    const state = deriveRunState(
      {},
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "waiting_for_gate", "gate-b")],
      graph,
    );
    expect(state.waitingOn).toEqual(["gate-a", "gate-b"]);
    // No single stage is "the" current one when two are halted; naming one would mislead.
    expect(state.currentStage).toBeUndefined();
  });

  it("reports completed once every goal succeeded", () => {
    const state = deriveRunState(
      {},
      [stage("first", "succeeded"), stage("second", "succeeded")],
      graph,
    );
    expect(state.status).toBe("completed");
    expect(state.outstandingGoals).toEqual([]);
  });

  it("does not complete while a goal is outstanding", () => {
    const state = deriveRunState(
      {},
      [stage("first", "succeeded"), stage("second", "never_run")],
      graph,
    );
    expect(state.status).not.toBe("completed");
    expect(state.outstandingGoals).toEqual(["second"]);
  });

  it("completes on the Run's own goals, ignoring stages it never intended to reach", () => {
    // The adopter's case: a stage conditional on the edition, and a run that stops short of
    // publishing. Under graph-completion neither would ever finish.
    const state = deriveRunState(
      { goalStages: ["first"] },
      [stage("first", "succeeded"), stage("second", "never_run")],
      graph,
    );
    expect(state.status).toBe("completed");
  });

  it("requires every goal when a Run declares several terminals", () => {
    const parallel: WorkflowGraph = {
      stages: [{ stageId: "caption" }, { stageId: "thumbnail" }],
    };
    const partial = deriveRunState(
      { goalStages: ["caption", "thumbnail"] },
      [stage("caption", "succeeded"), stage("thumbnail", "never_run")],
      parallel,
    );
    expect(partial.status).not.toBe("completed");

    const both = deriveRunState(
      { goalStages: ["caption", "thumbnail"] },
      [stage("caption", "succeeded"), stage("thumbnail", "succeeded")],
      parallel,
    );
    expect(both.status).toBe("completed");
  });

  it("never reports completed when no goals were declared", () => {
    // `[].every(...)` is true, so an unguarded rule would call a brand-new Run complete — the
    // emptiest possible claim, made confidently.
    const state = deriveRunState({}, [stage("first", "succeeded")], undefined);
    expect(state.status).not.toBe("completed");
    expect(state.completionBlockedBy).toBe("no_goals_declared");
  });

  it("completes despite a historical failure once the goals succeeded", () => {
    // §6.3 keeps failed attempts forever. If one suppressed completion, a single bad afternoon
    // would make the Run permanently uncompletable, and the only escape would be a new Run —
    // abandoning the accepted paid takes attached to this one (§15.1).
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "failed"), stage("second", "succeeded")],
      graph,
    );
    expect(state.status).toBe("completed");
  });

  it("reports failed when a stage failed and the goals are not met", () => {
    const state = deriveRunState(
      {},
      [stage("first", "failed"), stage("second", "never_run")],
      graph,
    );
    expect(state.status).toBe("failed");
  });

  it("prefers in-flight work over a recorded failure", () => {
    const state = deriveRunState({}, [stage("first", "failed"), stage("second", "running")], graph);
    expect(state.status).toBe("running");
  });

  it("reports running between stages, not created", () => {
    // Work has begun and nothing is in flight. §5.1 makes long pauses ordinary, so "in progress"
    // cannot mean "a process is executing right now".
    const state = deriveRunState(
      {},
      [stage("first", "succeeded"), stage("second", "never_run")],
      graph,
    );
    expect(state.status).toBe("running");
  });

  it("reports cancelled whatever the stages say", () => {
    const state = deriveRunState(
      { cancellation: { cancelledAt: "2026-01-01T00:00:00.000Z" } },
      [stage("first", "running"), stage("second", "waiting_for_gate", "gate-a")],
      graph,
    );
    expect(state.status).toBe("cancelled");
    // Nothing is being waited on any more; the Run is retired.
    expect(state.waitingOn).toEqual([]);
  });

  it("keeps cancelled even when every goal later succeeded", () => {
    // A human's decision is not revoked by subsequent activity.
    const state = deriveRunState(
      { cancellation: { cancelledAt: "2026-01-01T00:00:00.000Z" } },
      [stage("first", "succeeded"), stage("second", "succeeded")],
      graph,
    );
    expect(state.status).toBe("cancelled");
  });
});
