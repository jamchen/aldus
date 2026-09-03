/**
 * Deriving a Run's state (ADR-0026).
 *
 * `deriveRunState` is a pure function, so these exercise the rules directly against hand-built
 * snapshots rather than through a workspace. The integration side — that the services actually
 * report the derived value, and never write it back — lives in `services.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { deriveRunState, goalStagesFor } from "../src/runstate.js";
import type { GateSettlement, StageSnapshot } from "../src/nextaction.js";
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
    const state = deriveRunState({}, [stage("first", "never_run")], graph, []);
    expect(state.status).toBe("created");
  });

  it("reports running while a stage is in flight", () => {
    const state = deriveRunState({}, [stage("first", "running")], graph, []);
    expect(state.status).toBe("running");
    expect(state.currentStage).toBe("first");
  });

  it("reports waiting when a stage halted at a gate, and names the gate", () => {
    const state = deriveRunState(
      {},
      [stage("first", "waiting_for_gate", "content.freeze")],
      graph,
      [],
    );
    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toEqual(["content.freeze"]);
  });

  it("names every gate when several stages are halted", () => {
    const state = deriveRunState(
      {},
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "waiting_for_gate", "gate-b")],
      graph,
      [],
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
      [],
    );
    expect(state.status).toBe("completed");
    expect(state.outstandingGoals).toEqual([]);
  });

  it("does not complete while a goal is outstanding", () => {
    const state = deriveRunState(
      {},
      [stage("first", "succeeded"), stage("second", "never_run")],
      graph,
      [],
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
      [],
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
      [],
    );
    expect(partial.status).not.toBe("completed");

    const both = deriveRunState(
      { goalStages: ["caption", "thumbnail"] },
      [stage("caption", "succeeded"), stage("thumbnail", "succeeded")],
      parallel,
      [],
    );
    expect(both.status).toBe("completed");
  });

  it("never reports completed when no goals were declared", () => {
    // `[].every(...)` is true, so an unguarded rule would call a brand-new Run complete — the
    // emptiest possible claim, made confidently.
    const state = deriveRunState({}, [stage("first", "succeeded")], undefined, []);
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
      [],
    );
    expect(state.status).toBe("completed");
  });

  it("reports failed when a stage failed and the goals are not met", () => {
    const state = deriveRunState(
      {},
      [stage("first", "failed"), stage("second", "never_run")],
      graph,
      [],
    );
    expect(state.status).toBe("failed");
  });

  it("prefers in-flight work over a recorded failure", () => {
    const state = deriveRunState(
      {},
      [stage("first", "failed"), stage("second", "running")],
      graph,
      [],
    );
    expect(state.status).toBe("running");
  });

  it("reports running between stages, not created", () => {
    // Work has begun and nothing is in flight. §5.1 makes long pauses ordinary, so "in progress"
    // cannot mean "a process is executing right now".
    const state = deriveRunState(
      {},
      [stage("first", "succeeded"), stage("second", "never_run")],
      graph,
      [],
    );
    expect(state.status).toBe("running");
  });

  it("reports cancelled whatever the stages say", () => {
    const state = deriveRunState(
      { cancellation: { cancelledAt: "2026-01-01T00:00:00.000Z" } },
      [stage("first", "running"), stage("second", "waiting_for_gate", "gate-a")],
      graph,
      [],
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
      [],
    );
    expect(state.status).toBe("cancelled");
  });
});

/**
 * A stage parked on a gate that has since been settled (ADR-0059; #278).
 *
 * The adopter's shape: one stage parked, the gate decided, the path completed through a different
 * stage. Before this rule the Run reported `waiting` for as long as the record existed and named
 * the settled gate as what it waited on — with no action anywhere that could clear either.
 */
describe("a settled gate releases the stage parked on it", () => {
  const settled = (gateId: string): GateSettlement => ({ gateId, state: "satisfied" });

  it("is not waiting, and does not name the settled gate", () => {
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "succeeded")],
      graph,
      [settled("gate-a")],
    );
    expect(state.status).toBe("completed");
    expect(state.waitingOn).toEqual([]);
  });

  it("says which stage the decision released, and at which gate", () => {
    // The whole point of not reporting `waiting`: the stage is still parked, and nothing in the
    // runtime re-runs it, so dropping it silently would trade a wrong report for no report.
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "succeeded")],
      graph,
      [settled("gate-a")],
    );
    expect(state.releasedStages).toEqual([{ stageId: "first", gateId: "gate-a" }]);
  });

  it("treats a waived gate the same way", () => {
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "succeeded")],
      graph,
      [{ gateId: "gate-a", state: "waived" }],
    );
    expect(state.waitingOn).toEqual([]);
    expect(state.releasedStages).toHaveLength(1);
  });

  it("still waits on a gate that has not been settled", () => {
    // The negative control. Without it, a rule that released every parked stage regardless of its
    // gate would pass every case above.
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "succeeded")],
      graph,
      [{ gateId: "gate-a", state: "pending" }],
    );
    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toEqual(["gate-a"]);
    expect(state.releasedStages).toEqual([]);
  });

  it("keeps waiting on a gate that asked for changes: a decision, not a settlement", () => {
    // #241's runner predicate unparks the stage for any recorded decision, deliberately. This is
    // the other question — whether anything is outstanding — and a fresh decision is.
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "succeeded")],
      graph,
      [{ gateId: "gate-a", state: "changes_requested" }],
    );
    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toEqual(["gate-a"]);
  });

  it("keeps waiting on a rejected gate, which is the reason this predicate is narrower than #241's", () => {
    // The stated reason ADR-0059 does not reuse #241's "a decision exists": after a rejection a
    // fresh decision is outstanding, so the Run is waiting even though the runner would let the
    // stage be claimed. Bound here because a mutant adding "rejected" to the settled set survived
    // the suite — the narrowing was argued in the ADR and asserted nowhere.
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "succeeded")],
      graph,
      [{ gateId: "gate-a", state: "rejected" }],
    );
    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toEqual(["gate-a"]);
    expect(state.releasedStages).toEqual([]);
  });

  it("keeps waiting on a stale gate: an approval whose subjects moved is not a settlement", () => {
    // The state the first adopter actually produces — editing their script made the freeze gate
    // stale — and the one where "settled" would be most tempting, because a
    // person did approve. What they approved is not what is there now, so something is
    // outstanding. A mutant adding "stale" to the settled set survived the suite before this.
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "succeeded")],
      graph,
      [{ gateId: "gate-a", state: "stale" }],
    );
    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toEqual(["gate-a"]);
    expect(state.releasedStages).toEqual([]);
  });

  it("releases only the stage whose own gate is settled", () => {
    // A rule that ignored the gate id would release every parked stage from any settled gate.
    const state = deriveRunState(
      {},
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "waiting_for_gate", "gate-b")],
      graph,
      [settled("gate-a"), { gateId: "gate-b", state: "pending" }],
    );
    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toEqual(["gate-b"]);
    expect(state.currentStage).toBe("second");
    expect(state.releasedStages).toEqual([{ stageId: "first", gateId: "gate-a" }]);
  });

  it("keeps waiting when the parked gate is not among the states supplied", () => {
    // Conservative: an unknown gate is not evidence that a decision exists. A caller who can
    // supply no gate states gets exactly the pre-#278 answer, which is the safe direction.
    const state = deriveRunState(
      { goalStages: ["second"] },
      [stage("first", "waiting_for_gate", "gate-a"), stage("second", "succeeded")],
      graph,
      [],
    );
    expect(state.status).toBe("waiting");
    expect(state.waitingOn).toEqual(["gate-a"]);
  });

  it("reports running, not completed, when a released stage is the outstanding goal", () => {
    // The honest answer when the park is the work: there is something to do, and it is a `run`.
    const state = deriveRunState(
      { goalStages: ["first"] },
      [stage("first", "waiting_for_gate", "gate-a")],
      graph,
      [settled("gate-a")],
    );
    expect(state.status).toBe("running");
    expect(state.completionBlockedBy).toBe("goals_outstanding");
    expect(state.releasedStages).toEqual([{ stageId: "first", gateId: "gate-a" }]);
  });
});
