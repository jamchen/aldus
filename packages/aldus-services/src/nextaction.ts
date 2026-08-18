/**
 * Deciding the next safe action (architecture contract §24).
 *
 * §24's definition of done requires that "an operator can see current state and next safe action
 * without reading chat history". That is the hardest requirement in this package, and the reason
 * is that it is not a rendering problem. A list of stage statuses and gate statuses is a *data
 * dump*: it tells an operator what is true, and leaves them to work out what to do — which is
 * exactly the reasoning §3.4 says must not live in a session's memory.
 *
 * So this module answers two questions, and the second matters as much as the first:
 *
 * 1. What is safe to do now?
 * 2. For everything else that looks like it should be possible — **why is it not?**
 *
 * Without (2), an operator who expected to publish and finds no "publish" action cannot tell
 * whether the runtime forgot, whether they are missing a step, or whether something is blocking
 * them. A blocked action with a reason is the difference between a tool that reports and a tool
 * that explains.
 *
 * The policy is a **pure function** of state. Nothing here reads a file or a clock, so every
 * branch is reachable in a test without constructing a workspace, and the ordering below can be
 * asserted directly rather than inferred from an integration test.
 */

import type { GateStatus } from "@aldus-runtime/gate-engine";

/** Terminal and in-flight states a stage can be in (contract §6.3). */
export type StageSummaryStatus =
  "never_run" | "queued" | "running" | "waiting_for_gate" | "failed" | "succeeded" | "cancelled";

/** What the policy needs to know about one stage. */
export interface StageSnapshot {
  stageId: string;
  status: StageSummaryStatus;
  /** Gate the stage halted at, when `status` is `waiting_for_gate` (contract §11). */
  gateId?: string;
  /** Whether the recorded failure was classified retryable (contract §19.1). */
  retryable?: boolean;
  /** Ordinal of the latest attempt, absent when the stage has never run. */
  attempt?: number;
  /**
   * Gates that gate this stage (contract §11, ADR-0021).
   *
   * Three distinct values, and the difference matters:
   *
   * - **absent** — nothing declared which gates gate this stage. Treated conservatively: any
   *   blocking gate blocks it, and the reason says the stage is undeclared.
   * - **`[]`** — declared to require no gate. Runnable whatever else is pending.
   * - **a list** — blocked only by those gates.
   *
   * Resolved by the caller from the workflow graph and the stage definition, so this module stays
   * a pure function of state (see `workflow.ts`).
   */
  requiredGates?: readonly string[];
}

/** What the policy needs to know about a Run. */
export interface RunSnapshot {
  runId: string;
  status: "created" | "running" | "waiting" | "failed" | "completed" | "cancelled";
}

/** Input to {@link decideActions}. */
export interface ActionPolicyInput {
  run: RunSnapshot;
  /** Every stage the runtime knows about, run or not. */
  stages: readonly StageSnapshot[];
  /** Evaluated gate states (contract §13). */
  gates: readonly GateStatus[];
}

/**
 * Something an operator can do now.
 *
 * `kind` is an OPEN string. What can be done depends on which gates and stages an adopter
 * defined, so this code names no closed set (§4.2).
 */
export interface NextAction {
  kind: string;
  /** One sentence an operator can act on. */
  summary: string;
  /** Suggested invocation. An adapter may rewrite it; the CLI prints it verbatim. */
  command?: string;
  gateId?: string;
  stageId?: string;
  /**
   * Ordering hint, lower first.
   *
   * Exposed rather than kept private because an adapter that shows only one action needs to know
   * which one the runtime considers most urgent, and re-deriving that would duplicate the policy.
   */
  priority: number;
}

/**
 * How firmly a gate blocks a stage (contract §11, ADR-0021, ADR-0024).
 *
 * The difference decides whether `runStage` refuses, so it is part of the policy's answer rather
 * than something a caller infers:
 *
 * - **`enforced`** — the stage *declared* this gate, so the runtime knows the gate applies and
 *   refuses to run the stage until it is satisfied.
 * - **`advisory`** — nothing declared which gates gate this stage, so the conservative fallback
 *   assumes every blocking gate might. Worth telling an operator; **not** grounds to refuse.
 */
export type BlockEnforcement = "enforced" | "advisory";

/** Something that looks possible but is not, and why. */
export interface BlockedAction {
  kind: string;
  summary: string;
  /** Why it is not safe, in terms an operator can act on. */
  reason: string;
  gateId?: string;
  stageId?: string;
  /**
   * Whether this block actually stops the operation (ADR-0024).
   *
   * Absent for blocks that are not about gates. Present on gate-related blocks so an adapter can
   * distinguish "decide this gate before this stage will run" from "I cannot tell whether this
   * gate applies — declare the stage's required gates to narrow it". The second is a prompt to
   * improve the workflow declaration, not a barrier, and the two read identically without it.
   */
  enforcement?: BlockEnforcement;
}

/** The policy's answer. */
export interface ActionPlan {
  /** Safe actions, most urgent first. */
  next: NextAction[];
  /** Actions deliberately withheld, each with its reason. */
  blocked: BlockedAction[];
  /**
   * One sentence describing the Run's situation.
   *
   * Present even when `next` is empty — "nothing to do because the Run completed" and "nothing
   * to do because everything is blocked" are very different situations and an operator must not
   * have to infer which one they are in from an empty list.
   */
  summary: string;
}

/** Priorities. Lower is more urgent; gaps leave room for an adopter to interleave. */
const PRIORITY = {
  /** A drifted approval is actively dangerous: §13.1/§13.2 treat it as void, but it still reads as "approved" to a human skimming. */
  staleGate: 10,
  /** A stage is halted and cannot move until someone decides. */
  gateAwaitingDecision: 20,
  /** A failure the runtime says is safe to re-attempt. */
  retryStage: 30,
  /** Ordinary forward progress. */
  runStage: 40,
} as const;

/** Gate states from which a fresh decision can be recorded right now. */
const DECIDABLE_STATES = new Set(["pending", "stale", "changes_requested"]);

/** True when the gate stops work (contract §12: an advisory gate never blocks). */
function isBlocking(gate: GateStatus): boolean {
  return gate.blocking;
}

/**
 * Decide what is safe to do next, and why everything else is not.
 *
 * Ordering is deliberate and asserted by tests:
 *
 * 1. **Stale approvals first.** §13.1 and §13.2 make a drifted approval void, but it still reads
 *    as "approved" to anyone skimming, so it is the most dangerous state to leave unresolved.
 * 2. **Gates a stage is actually halted on.** These are what is stopping the Run right now.
 * 3. **Retryable failures**, which need no new decision.
 * 4. **Stages that have never run**, i.e. ordinary forward progress.
 *
 * A gate in `blocked_upstream` is never offered: deciding it would record an approval that
 * §13.1's cascade immediately voids, which teaches an operator that approvals do not stick.
 *
 * Which gates block which stages comes from {@link StageSnapshot.requiredGates}, resolved by the
 * caller from the workflow graph and the stage definitions (ADR-0021). When nothing declares an
 * association, every blocking gate blocks every unrun stage — the behaviour before ADR-0021, kept
 * so that a workflow declaring nothing is unaffected.
 */
export function decideActions(input: ActionPolicyInput): ActionPlan {
  const { run, stages, gates } = input;
  const next: NextAction[] = [];
  const blocked: BlockedAction[] = [];

  if (run.status === "cancelled") {
    return {
      next: [],
      blocked: [],
      summary: `Run ${run.runId} was cancelled. Start a new Run to continue this Episode.`,
    };
  }

  const gateById = new Map(gates.map((gate) => [gate.gateId, gate]));

  // Whether *any* source declared a stage↔gate association for this workflow. Derived from the
  // snapshots rather than passed as a flag, so there is one place the answer can come from and no
  // way for a flag to disagree with the data (ADR-0021).
  const associationDeclared = stages.some((stage) => stage.requiredGates !== undefined);

  // 1. Stale approvals, blocking or not. An advisory gate that drifted is not stopping work, so
  //    it is reported as blocked-with-reason rather than urged — but it is never silently dropped.
  for (const gate of gates) {
    if (gate.state !== "stale") continue;
    if (isBlocking(gate)) {
      next.push({
        kind: "approve-gate",
        summary:
          `Re-approve "${gate.gateId}": it was approved, but a bound value has changed since, ` +
          "so the approval no longer covers what would be produced.",
        command: `aldus approve ${gate.gateId} --run ${run.runId}`,
        gateId: gate.gateId,
        priority: PRIORITY.staleGate,
      });
    } else {
      blocked.push({
        kind: "approve-gate",
        summary: `Re-approve "${gate.gateId}"`,
        reason:
          "The approval drifted, but this gate is advisory and is not stopping work " +
          "(contract §12 level 2).",
        gateId: gate.gateId,
      });
    }
  }

  // 2. Gates a stage is halted on.
  const haltedGateIds = new Set<string>();
  for (const stage of stages) {
    if (stage.status !== "waiting_for_gate" || stage.gateId === undefined) continue;
    haltedGateIds.add(stage.gateId);
    const gate = gateById.get(stage.gateId);

    if (gate === undefined) {
      blocked.push({
        kind: "approve-gate",
        summary: `Decide "${stage.gateId}" so stage "${stage.stageId}" can continue`,
        reason:
          `Stage "${stage.stageId}" halted at gate "${stage.gateId}", but no such gate is ` +
          "registered, so there is nothing to decide. Register the gate, or the Run cannot advance.",
        gateId: stage.gateId,
        stageId: stage.stageId,
      });
      continue;
    }

    if (gate.state === "blocked_upstream") {
      blocked.push({
        kind: "approve-gate",
        summary: `Decide "${gate.gateId}" so stage "${stage.stageId}" can continue`,
        reason:
          `"${gate.gateId}" depends on ${formatList(gate.blockedBy ?? [])}, which ` +
          "must be satisfied first (contract §13.1). Deciding it now would be voided by the cascade.",
        gateId: gate.gateId,
        stageId: stage.stageId,
      });
      continue;
    }

    if (DECIDABLE_STATES.has(gate.state) && gate.state !== "stale") {
      next.push({
        kind: "approve-gate",
        summary:
          `Decide "${gate.gateId}": stage "${stage.stageId}" is halted waiting for it ` +
          `(${gate.level === "human_oracle" ? "human judgement required" : gate.level}).`,
        command: `aldus approve ${gate.gateId} --run ${run.runId}`,
        gateId: gate.gateId,
        stageId: stage.stageId,
        priority: PRIORITY.gateAwaitingDecision,
      });
    }
  }

  // 3. Failed stages.
  for (const stage of stages) {
    if (stage.status !== "failed") continue;

    // A gate that blocks running a stage blocks retrying it too: a retry re-executes the stage,
    // so offering one while a required gate is unsatisfied would put `status` and `aldus retry`
    // back in the disagreement ADR-0024 exists to remove.
    const gateBlocker = blockerFor(stage, gates, gateById, associationDeclared);
    if (gateBlocker?.enforcement === "enforced") {
      blocked.push({
        kind: "retry-stage",
        summary: `Retry "${stage.stageId}"`,
        reason: gateBlocker.reason,
        stageId: stage.stageId,
        enforcement: gateBlocker.enforcement,
        ...(gateBlocker.gateId !== undefined ? { gateId: gateBlocker.gateId } : {}),
      });
      continue;
    }

    if (stage.retryable === true) {
      next.push({
        kind: "retry-stage",
        summary: `Retry "${stage.stageId}": its recorded failure is classified retryable.`,
        command: `aldus retry ${stage.stageId} --run ${run.runId}`,
        stageId: stage.stageId,
        priority: PRIORITY.retryStage,
      });
    } else {
      blocked.push({
        kind: "retry-stage",
        summary: `Retry "${stage.stageId}"`,
        reason:
          "The recorded failure is not classified retryable (contract §19.1), so re-attempting " +
          "it unchanged would fail the same way. Fix the cause, then retry.",
        stageId: stage.stageId,
      });
    }
  }

  // 4. Stages that could run, and stages that cannot.
  for (const stage of stages) {
    if (stage.status === "running") {
      blocked.push({
        kind: "run-stage",
        summary: `Run "${stage.stageId}"`,
        reason:
          "The stage is already claimed by a running attempt. Taking it over needs --force, and " +
          "only when you know the other session is gone — two runners on one side-effecting " +
          "stage is worse than waiting.",
        stageId: stage.stageId,
      });
      continue;
    }
    if (stage.status !== "never_run" && stage.status !== "queued") continue;

    const blocker = blockerFor(stage, gates, gateById, associationDeclared);
    if (blocker !== undefined) {
      blocked.push({
        kind: "run-stage",
        summary: `Run "${stage.stageId}"`,
        reason: blocker.reason,
        stageId: stage.stageId,
        enforcement: blocker.enforcement,
        ...(blocker.gateId !== undefined ? { gateId: blocker.gateId } : {}),
      });
      // Reported and not offered, enforced or not — this is exactly what `status` printed before
      // ADR-0024, and that wording is unchanged. What changed is only whether `runStage` refuses:
      // an advisory block explains a risk, an enforced one stops the work.
      continue;
    }

    next.push({
      kind: "run-stage",
      summary: `Run "${stage.stageId}": it has not run in this Run yet.`,
      command: `aldus run ${stage.stageId} --run ${run.runId}`,
      stageId: stage.stageId,
      priority: PRIORITY.runStage,
    });
  }

  // Operations that gates grant but nobody has authorized. Reported even when no stage asked for
  // them: an operator wondering "why can I not publish" needs the answer to be present.
  for (const gate of gates) {
    if (gate.state === "satisfied" || haltedGateIds.has(gate.gateId)) continue;
    if (gate.state === "stale") continue; // already reported above
    blocked.push({
      kind: "gate-not-satisfied",
      summary: `Anything "${gate.gateId}" authorizes`,
      reason:
        gate.explanation ??
        `"${gate.gateId}" is ${gate.state}, so the operations it authorizes are refused.`,
      gateId: gate.gateId,
    });
  }

  next.sort((a, b) => a.priority - b.priority || a.summary.localeCompare(b.summary));

  return { next, blocked, summary: summarise(run, next, blocked, stages) };
}

/** Why a stage may not run, when something stops it. */
export interface StageBlocker {
  /** Operator-facing explanation, identical to the one `status` prints for this state. */
  reason: string;
  /** The gate responsible, when one is identifiable. */
  gateId?: string;
  /** Whether this actually stops the stage running, or is only worth saying. @see BlockEnforcement */
  enforcement: BlockEnforcement;
}

/**
 * Whether a gate **stops** this stage from running (contract §11, §13, ADR-0024).
 *
 * Returns a blocker only when the stage declared the gate, so this is what `AldusServices.runStage`
 * refuses on. The conservative fallback for an undeclared stage is deliberately *not* enforceable:
 * a hint can afford to over-warn, an enforcement rule cannot. Every gate is unsatisfied when a Run
 * starts, so refusing on the fallback would refuse every stage in a workflow that declared nothing
 * — and the subjects those gates bind are produced by the very stages being refused. That is a
 * deadlock, not a refusal an operator can act on.
 *
 * Enforcement and display share one implementation, and the enforceable/advisory judgement lives
 * here rather than at a call site: computing blocked-ness a second way is exactly how `status` and
 * `run` came to disagree in the first place.
 *
 * A stage absent from `input.stages` is evaluated conservatively rather than waved through: an
 * unknown stage is not evidence that nothing gates it (ADR-0021).
 */
export function enforcedGateBlockerFor(
  stageId: string,
  input: ActionPolicyInput,
): StageBlocker | undefined {
  const blocker = gateBlockerFor(stageId, input);
  return blocker?.enforcement === "enforced" ? blocker : undefined;
}

/**
 * Whether any gate is worth reporting against this stage, enforced or not (ADR-0024).
 *
 * Callers deciding whether to *act* want {@link enforcedGateBlockerFor}. This one is for display.
 */
export function gateBlockerFor(
  stageId: string,
  input: ActionPolicyInput,
): StageBlocker | undefined {
  const stage = input.stages.find((candidate) => candidate.stageId === stageId) ?? {
    stageId,
    status: "never_run" as const,
  };
  const gateById = new Map(input.gates.map((gate) => [gate.gateId, gate]));
  const associationDeclared = input.stages.some(
    (candidate) => candidate.requiredGates !== undefined,
  );
  return blockerFor(stage, input.gates, gateById, associationDeclared);
}

/**
 * Decide whether a gate stops this particular stage (contract §11, §13, ADR-0021).
 *
 * Three paths, and each exists for a stated reason:
 *
 * 1. **No association declared anywhere** — fall back to the original behaviour: any blocking gate
 *    blocks every unrun stage. Over-blocking, but safe, and it keeps a workflow that declares
 *    nothing behaving exactly as it did before ADR-0021.
 * 2. **This stage is undeclared while others are declared** — the same conservative fallback, but
 *    the reason says the stage is missing from the graph. Silently treating an unlisted stage as
 *    unblocked would let an omission quietly unblock work, which is the worse failure; saying so
 *    out loud makes the omission fixable instead of invisible.
 * 3. **This stage declares its gates** — blocked only by those, and the offending gate is named.
 */
function blockerFor(
  stage: StageSnapshot,
  gates: readonly GateStatus[],
  gateById: ReadonlyMap<string, GateStatus>,
  associationDeclared: boolean,
): StageBlocker | undefined {
  const required = stage.requiredGates;

  if (required === undefined) {
    const blocker = gates.find((gate) => isBlocking(gate));
    if (blocker === undefined) return undefined;
    // Advisory, never enforced. Nothing declared that this gate gates this stage, so the runtime
    // is guessing — and a guess must not refuse work (ADR-0024).
    return {
      gateId: blocker.gateId,
      enforcement: "advisory",
      reason: associationDeclared
        ? `Gate "${blocker.gateId}" is ${blocker.state} and is blocking (contract §13). ` +
          `Stage "${stage.stageId}" is not declared in the workflow graph, so every blocking ` +
          "gate is assumed to gate it. Declare its required gates to narrow this."
        : `Gate "${blocker.gateId}" is ${blocker.state} and is blocking (contract §13). ` +
          "Decide it first.",
    };
  }

  for (const gateId of required) {
    const gate = gateById.get(gateId);
    if (gate === undefined) {
      // Declared, so enforced: the stage named a gate that does not exist. Running it anyway
      // would proceed past a guard the adopter believes is protecting it.
      return {
        gateId,
        enforcement: "enforced",
        reason:
          `Stage "${stage.stageId}" requires gate "${gateId}", which is not registered, so it ` +
          "cannot be satisfied. Register the gate, or remove it from the stage's requirements.",
      };
    }
    if (isBlocking(gate)) {
      return {
        gateId,
        enforcement: "enforced",
        reason:
          `Gate "${gateId}" is ${gate.state} and is blocking (contract §13). Stage ` +
          `"${stage.stageId}" requires it. Decide it first.`,
      };
    }
  }

  return undefined;
}

/** Join ids as prose, so a reason reads as a sentence rather than a serialised array. */
function formatList(ids: readonly string[]): string {
  if (ids.length === 0) return "an upstream gate";
  if (ids.length === 1) return `"${ids[0]}"`;
  const quoted = ids.map((id) => `"${id}"`);
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** One sentence for the Run's situation. */
function summarise(
  run: RunSnapshot,
  next: readonly NextAction[],
  blocked: readonly BlockedAction[],
  stages: readonly StageSnapshot[],
): string {
  if (next.length > 0) {
    const first = next[0];
    return first === undefined
      ? `Run ${run.runId} is ${run.status}.`
      : `Run ${run.runId} is ${run.status}. Next: ${first.summary}`;
  }

  if (run.status === "completed") {
    return `Run ${run.runId} is complete. Nothing is outstanding.`;
  }

  if (stages.length === 0) {
    return (
      `Run ${run.runId} is ${run.status}, and no stages are registered, so there is nothing to ` +
      "run. Register the workflow's stages before continuing."
    );
  }

  if (blocked.length > 0) {
    return (
      `Run ${run.runId} is ${run.status} and nothing is currently safe to do — ` +
      `${blocked.length} action${blocked.length === 1 ? " is" : "s are"} blocked. ` +
      "See the reasons below."
    );
  }

  return `Run ${run.runId} is ${run.status}, with nothing outstanding and nothing blocked.`;
}
