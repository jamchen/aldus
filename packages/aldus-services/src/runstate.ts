/**
 * Deriving a Run's current state (architecture contract §6.2, §19.1; ADR-0026).
 *
 * `RunManifest.status` records the state a Run was *created* in and is never rewritten. The live
 * answer is computed here, from the stage executions and the manifest's `cancellation` record.
 *
 * That follows the pattern the runtime already uses where a summary could disagree with its
 * source: ADR-0009 derives gate state rather than storing invalidations, and ADR-0008 makes
 * `stages.json` a cache rather than truth. A stored Run status has the same failure mode, and
 * demonstrated it — written once at creation, it left four of §6.2's six states unreachable.
 *
 * Deliberately a pure function of a snapshot: nothing here reads a store, so the rules can be
 * tested against hand-built states and a caller cannot accidentally make a status depend on when
 * it was asked.
 */

import type { RunStatus } from "@aldus-runtime/core";

import { gateIsSettled, type GateSettlement, type StageSnapshot } from "./nextaction.js";
import type { WorkflowGraph } from "./workflow.js";

/**
 * A parked stage whose gate has since been settled (ADR-0059; #241, #278).
 *
 * Not a wait: the decision exists, so the stage is runnable and nothing but running it will move
 * it. It is reported rather than silently dropped, because a parked attempt nobody re-runs is
 * still a fact about the Run — and the operator's action is `run`, not `approve`.
 */
export interface ReleasedPark {
  /** The stage whose latest attempt is `waiting_for_gate`. */
  stageId: string;
  /** The gate it parked at, now `satisfied` or `waived`. */
  gateId: string;
}

/** The parts of a Run manifest that determine its state. */
export interface RunStateSource {
  /**
   * Present only when a human abandoned the Run (contract §19.1).
   *
   * Structurally typed rather than importing `RunManifest`, so the rules can be exercised against
   * hand-built states without constructing a whole manifest.
   */
  cancellation?: { cancelledAt: string; reason?: string | undefined } | undefined;
  /** The stages this Run intends to reach, when it declared any. */
  goalStages?: readonly string[] | undefined;
}

/** A Run's derived situation. */
export interface RunState {
  /** Where the Run is now (contract §6.2). */
  status: RunStatus;
  /**
   * The stage the Run is at, when exactly one is in flight or halted.
   *
   * Absent when several are — naming one of them would be arbitrary, and an operator reading a
   * single name would reasonably assume it was the only one.
   */
  currentStage?: string;
  /**
   * Gates the Run is waiting on, when `status` is `waiting`.
   *
   * Named at the Run level because "waiting" alone sends an operator hunting through a workflow's
   * gates to find which one. The per-stage detail already existed; it simply was not surfaced up.
   *
   * **A settled gate is never here** (ADR-0059). Before that, every gate a parked attempt named
   * appeared for as long as the record existed, so `status` told an operator to go and decide
   * something that had already been decided — and `waitingOn` was the field it read (#278).
   */
  waitingOn: readonly string[];
  /**
   * Parked stages whose gate has since been settled (ADR-0059).
   *
   * These are why the Run is *not* `waiting` despite a `waiting_for_gate` attempt in the record:
   * a decided gate releases the stage parked on it (#241), so the outstanding action is to run
   * the stage again. Empty in the ordinary case.
   */
  releasedStages: readonly ReleasedPark[];
  /** The goals in force, whether declared on the Run or defaulted from the graph. */
  goalStages: readonly string[];
  /** Goals not yet succeeded. Empty when every goal is met — or when none were declared. */
  outstandingGoals: readonly string[];
  /** Why the Run is not `completed`, when it is not and the reason is structural. */
  completionBlockedBy?: "no_goals_declared" | "goals_outstanding" | "work_in_flight";
}

/**
 * The goals a Run is measured against.
 *
 * A Run's own declaration wins. Falling back to every stage the graph names is the naive reading
 * of "finished" — right for a workflow whose stages all always run, and wrong for one where a
 * stage is conditional on what is being produced. That is exactly why a Run may override it: the
 * default is a convenience, not the rule (ADR-0026).
 *
 * The graph carries no edges, so a true terminal stage is not derivable from it. Every named
 * stage is used instead, which is the honest reading of a graph that only records stage↔gate
 * associations.
 */
export function goalStagesFor(
  source: RunStateSource,
  graph: WorkflowGraph | undefined,
): readonly string[] {
  if (source.goalStages !== undefined) return source.goalStages;
  if (graph === undefined) return [];
  return graph.stages.map((node) => node.stageId);
}

/**
 * Derive a Run's current state.
 *
 * Precedence, and every step of it is load-bearing:
 *
 * 1. **cancelled** — an explicit record beats any amount of observed activity, because a human
 *    said so and no later event revokes that.
 * 2. **running** — something is in flight right now.
 * 3. **waiting** — halted at a gate **that still awaits a decision**. §5.1 makes this an ordinary
 *    resting state, not an error. A stage parked on a gate that has since been settled is
 *    *released*, not waiting (ADR-0059): the decision exists, the stage can be run again, and
 *    nothing an operator does to the gate would change anything.
 * 4. **completed** — every declared goal succeeded.
 * 5. **failed** — a stage's latest attempt failed.
 * 6. **created** — nothing has run.
 *
 * `completed` deliberately precedes `failed`. The Run status answers *where this Run is*, not
 * *whether the work was good*: quality is adjudicated by gates, and a failure that mattered
 * blocks a gate and stops the goals succeeding anyway. Since §6.3 makes attempts append-only, a
 * failure that was diagnosed and re-run green stays in the record forever — so letting one
 * suppress completion would make a Run permanently uncompletable after a single bad afternoon,
 * and the only escape would be a new Run, abandoning the accepted paid takes attached to the old
 * one (§15.1).
 *
 * `gates` is **required**, not optional with a default (ADR-0059). A caller who omitted it would
 * silently get the pre-#278 answer — every parked attempt a permanent wait — which is exactly the
 * defect, restored by forgetting an argument. Pass `[]` to state that no gate states are
 * available; a gate absent from the list is then evaluated conservatively as still awaiting a
 * decision, since an unknown gate is not evidence that one exists (the same rule ADR-0021 applies
 * to an unknown stage).
 */
export function deriveRunState(
  source: RunStateSource,
  stages: readonly StageSnapshot[],
  graph: WorkflowGraph | undefined,
  gates: readonly GateSettlement[],
): RunState {
  const goalStages = goalStagesFor(source, graph);
  const succeeded = new Set(
    stages.filter((stage) => stage.status === "succeeded").map((stage) => stage.stageId),
  );
  const outstandingGoals = goalStages.filter((stageId) => !succeeded.has(stageId));

  const inFlight = stages.filter(
    (stage) => stage.status === "running" || stage.status === "queued",
  );
  // A parked attempt is one of two very different things, and before ADR-0059 both read as the
  // first: a gate someone still has to decide, or a gate that has been decided and therefore
  // releases the stage (#241). Only the first is a wait.
  const settled = new Set(
    gates.filter((gate) => gateIsSettled(gate.state)).map((gate) => gate.gateId),
  );
  const parked = stages.filter((stage) => stage.status === "waiting_for_gate");
  const releasedStages: ReleasedPark[] = [];
  const halted: StageSnapshot[] = [];
  for (const stage of parked) {
    // An attempt parked with no gate recorded cannot be shown to be released, so it stays a wait.
    if (stage.gateId !== undefined && settled.has(stage.gateId)) {
      releasedStages.push({ stageId: stage.stageId, gateId: stage.gateId });
    } else {
      halted.push(stage);
    }
  }
  const waitingOn = [
    ...new Set(halted.flatMap((stage) => (stage.gateId === undefined ? [] : [stage.gateId]))),
  ];

  const base = { waitingOn, goalStages, outstandingGoals, releasedStages };

  if (source.cancellation !== undefined) {
    return { ...base, status: "cancelled", waitingOn: [] };
  }

  if (inFlight.length > 0) {
    return {
      ...base,
      status: "running",
      ...soleStage(inFlight),
      completionBlockedBy: "work_in_flight",
    };
  }

  if (halted.length > 0) {
    return {
      ...base,
      status: "waiting",
      ...soleStage(halted),
      completionBlockedBy: "work_in_flight",
    };
  }

  // Guarded against the vacuous case on purpose: `[].every(...)` is true, so a Run that declared
  // no goals and has a graph-less context would otherwise report `completed` the instant it was
  // created — the emptiest possible claim, made confidently.
  if (goalStages.length > 0 && outstandingGoals.length === 0) {
    return { ...base, status: "completed" };
  }

  const failed = stages.some((stage) => stage.status === "failed");
  if (failed) {
    return {
      ...base,
      status: "failed",
      ...(goalStages.length === 0
        ? { completionBlockedBy: "no_goals_declared" as const }
        : { completionBlockedBy: "goals_outstanding" as const }),
    };
  }

  // Work has begun, nothing is in flight, nothing is halted, and the goals are not met: a Run
  // resting between stages. §6.2 offers no idle state, and `running` is the honest one — §5.1
  // makes long pauses ordinary, so "in progress" cannot mean "a process is executing right now".
  // `waiting` is reserved for being halted at a gate, which is a different thing an operator
  // acts on differently.
  //
  // A released park lands here too, and `running` is the honest answer for it: the work outstanding
  // is a stage to run, exactly like a stage that has never run. `releasedStages` says which one,
  // so "in progress" is not the whole answer an operator gets (ADR-0059).
  const started = stages.some((stage) => stage.status !== "never_run");
  return {
    ...base,
    status: started ? "running" : "created",
    ...(goalStages.length === 0
      ? { completionBlockedBy: "no_goals_declared" as const }
      : { completionBlockedBy: "goals_outstanding" as const }),
  };
}

/** Name the stage only when there is exactly one; several would make any single name misleading. */
function soleStage(stages: readonly StageSnapshot[]): { currentStage?: string } {
  const only = stages.length === 1 ? stages[0] : undefined;
  return only === undefined ? {} : { currentStage: only.stageId };
}
