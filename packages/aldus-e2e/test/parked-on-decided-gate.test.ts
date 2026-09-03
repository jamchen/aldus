/**
 * One stage parked, the gate decided, the path completed through another stage (#278, ADR-0059).
 *
 * The first adopter's shape, reproduced on a real Run: a repair loop's stage threw
 * `GateRequiredSignal` and parked; the operator decided the gate; a **different** stage consumed
 * the decision and succeeded; the loop that would have driven the parked stage had already
 * recorded its stop and does not re-enter. The record was correct throughout — the *report* of it
 * was not:
 *
 * ```
 * Run run_… (waiting) at script.revise
 * Waiting  script.comprehension
 * ```
 *
 * `script.comprehension` was `satisfied`. So the Run reported `waiting` for as long as the record
 * existed, named a decided gate as the thing to decide, and offered no action that could clear
 * either — the parked stage appeared in neither the plan's `next` nor its `blocked`.
 *
 * It lives here rather than in a unit suite because the defect was in the composition: the
 * derivation had the stage record and not the gate states, and each half was individually
 * correct. The unit rules are asserted in `@aldus-runtime/services`
 * (`runstate.test.ts`, `nextaction.test.ts`) and the rendering in `@aldus-runtime/cli`.
 */

import { digestSubjectValue } from "@aldus-runtime/gate-engine";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT_FREEZE_GATE,
  NARRATION_STAGE,
  OPERATOR,
  REVIEW_STAGE,
  RUN_ID,
  SHOW_ID,
  aGrant,
  aPlan,
  gatedStage,
  journeyGates,
  journeySubjects,
  makeStack,
  producingStage,
  type Stack,
} from "../src/index.js";

const PLAN = aPlan();
const CONTENT = "the-frozen-content";

let stack: Stack;

afterEach(async () => {
  await stack.cleanup();
});

/**
 * The adopter's two stages, and the Run's declared goal.
 *
 * `REVIEW_STAGE` is the one that parks. `NARRATION_STAGE` is the path that completes, and it is
 * the Run's only declared goal — which is the adopter's case exactly: the parked stage is not what
 * finishing means (ADR-0026 decision 2).
 *
 * Both stages declare `requiredGates: []`, so nothing here rests on the conservative fallback that
 * assumes every blocking gate gates every unrun stage (ADR-0021). The gate reaches the parked
 * stage the way it did for the adopter — the stage asked for it at runtime.
 */
async function seeded(): Promise<Stack> {
  stack = await makeStack({
    gates: journeyGates(PLAN).filter((gate) => gate.gateId === CONTENT_FREEZE_GATE),
    workflow: {
      workflowId: "workflow-a",
      workflowVersion: "1",
      stages: [
        { stageId: REVIEW_STAGE, requiredGates: [] },
        { stageId: NARRATION_STAGE, requiredGates: [] },
      ],
    },
    stages: (registry, workingRoot) => [
      gatedStage(REVIEW_STAGE, CONTENT_FREEZE_GATE, [digestSubjectValue(CONTENT)]),
      producingStage(NARRATION_STAGE, {
        workingRoot,
        relativePath: "narration.txt",
        contents: "The first line.\n",
        kind: "ApprovedNarration",
        mediaType: "text/plain",
        reconstructability: "irreplaceable",
        registry,
      }),
    ],
  });
  stack.state.subjects = journeySubjects({
    content: CONTENT,
    render: "render-a",
    plan: PLAN,
    grant: aGrant(),
  });
  await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
  await stack.services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: RUN_ID,
    goalStages: [NARRATION_STAGE],
    actor: OPERATOR,
  });
  return stack;
}

/** Drive the adopter's sequence: park, decide, complete through the other stage. */
async function parkedThenDecidedThenCompleted(): Promise<Stack> {
  await seeded();
  await stack.services.runStage({ runId: RUN_ID, stageId: REVIEW_STAGE, actor: OPERATOR });
  await stack.services.approve({
    runId: RUN_ID,
    gateId: CONTENT_FREEZE_GATE,
    comment: "Reads correctly.",
    actor: OPERATOR,
  });
  await stack.services.runStage({ runId: RUN_ID, stageId: NARRATION_STAGE, actor: OPERATOR });
  return stack;
}

describe("the adopter's shape: parked on a gate that has since been satisfied", () => {
  it("is waiting, and names the gate, while the decision is genuinely outstanding", async () => {
    // The control the other cases rest on. Nothing below is evidence of anything if the state it
    // is compared against was never reached.
    await seeded();
    await stack.services.runStage({ runId: RUN_ID, stageId: REVIEW_STAGE, actor: OPERATOR });

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") throw new Error("status refused");
    expect(status.data.focused?.state.status).toBe("waiting");
    expect(status.data.focused?.state.waitingOn).toEqual([CONTENT_FREEZE_GATE]);
    expect(status.data.focused?.state.releasedStages).toEqual([]);
  });

  it("stops reporting the Run as waiting once the gate is satisfied", async () => {
    await parkedThenDecidedThenCompleted();

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") throw new Error("status refused");
    expect(status.data.focused?.state.status).toBe("completed");
    expect(status.data.focused?.state.waitingOn).toEqual([]);
  });

  it("does not name the satisfied gate as something to decide", async () => {
    await parkedThenDecidedThenCompleted();

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") throw new Error("status refused");
    const gate = status.data.focused?.gates.find((entry) => entry.gateId === CONTENT_FREEZE_GATE);
    // The premise: the gate really is satisfied in this composition, not merely absent.
    expect(gate?.state).toBe("satisfied");
    expect(status.data.focused?.state.waitingOn).not.toContain(CONTENT_FREEZE_GATE);
    // No action asks anyone to decide it. The re-run action names the gate too — as the reason
    // the stage is runnable, which is the opposite claim and the one an operator needs.
    expect(
      status.data.focused?.plan.next.filter((action) => action.kind === "approve-gate"),
    ).toEqual([]);
    expect(
      status.data.focused?.plan.blocked.filter((entry) => entry.kind === "approve-gate"),
    ).toEqual([]);
  });

  it("says which stage the decision released, and offers running it again", async () => {
    await parkedThenDecidedThenCompleted();

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") throw new Error("status refused");
    expect(status.data.focused?.state.releasedStages).toEqual([
      { stageId: REVIEW_STAGE, gateId: CONTENT_FREEZE_GATE },
    ]);
    const action = status.data.focused?.plan.next.find(
      (entry) => entry.kind === "run-stage" && entry.stageId === REVIEW_STAGE,
    );
    expect(action?.command).toContain(`aldus run ${REVIEW_STAGE}`);
    expect(action?.summary).toContain("has been decided");
  });

  it("leaves the stage record exactly as it was: the report changed, not the truth", async () => {
    // ADR-0026's load-bearing half. A fix that transitioned the stored status out of
    // `waiting_for_gate` would make the report agree by rewriting the record §6.3 keeps.
    await parkedThenDecidedThenCompleted();

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") throw new Error("status refused");
    const parked = status.data.focused?.stages.find((entry) => entry.stageId === REVIEW_STAGE);
    expect(parked?.status).toBe("waiting_for_gate");
    expect(parked?.attempt).toBe(1);
  });

  it("reports the same thing in a list of Runs, which reads its own path", async () => {
    // A different code path from the focused report — and the one an operator greps across a
    // directory of Runs. Before this, the list needed no gate states and so could not have told
    // a released park from a wait.
    await parkedThenDecidedThenCompleted();

    const status = await stack.services.status();
    if (status.outcome !== "ok") throw new Error("status refused");
    const summary = status.data.runs.find((entry) => entry.runId === RUN_ID);
    expect(summary?.status).toBe("completed");
    expect(summary?.waitingOn).toBeUndefined();
  });

  it("offers a command the runtime accepts: the stage runs rather than being refused", async () => {
    // ADR-0024's rule, applied to the new action: `status` must not send an operator at a command
    // the runtime will refuse on a precondition. It does not — the claim succeeds and a second
    // attempt executes, which is #241's release working through the composed stack.
    //
    // What happens *inside* the stage is the stage's business, and this fixture is the extreme
    // case: it asks for the same gate unconditionally. ADR-0058 answers that with a conflict that
    // names the remedy, so even the worst-behaved parked stage produces an actionable sentence
    // rather than a silent second park. That is a fact about this fixture, not a claim that every
    // adopter's re-run fails.
    await parkedThenDecidedThenCompleted();

    const again = await stack.services.runStage({
      runId: RUN_ID,
      stageId: REVIEW_STAGE,
      actor: OPERATOR,
    });
    // Not `refused`, which is what the pre-#241 claim check produced: the stage was claimed and
    // re-executed, reaching attempt 2.
    expect(again.outcome).toBe("unsuccessful");
    if (again.outcome !== "unsuccessful") return;
    expect(again.data.attempt).toBe(2);
    expect(again.error?.code).toBe("ALDUS_GATE_ALREADY_DECIDED");
    expect(again.error?.message).toContain("must consume it rather than ask again");
  });

  it("survives a restart, so the answer does not depend on a session remembering it", async () => {
    // §3.4: session memory is never the storage location. The derivation reads the durable
    // records, so a fresh process must reach the same answer.
    await parkedThenDecidedThenCompleted();
    const fresh = stack.restart();

    const status = await fresh.status(RUN_ID);
    if (status.outcome !== "ok") throw new Error("status refused");
    expect(status.data.focused?.state.status).toBe("completed");
    expect(status.data.focused?.state.releasedStages).toEqual([
      { stageId: REVIEW_STAGE, gateId: CONTENT_FREEZE_GATE },
    ]);
  });
});
