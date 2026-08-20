/**
 * Gate enforcement at the service layer (contract §11, §13; ADR-0024).
 *
 * §11 requires a stage to "stop at required gates". `@aldus-runtime/stage-runner` genuinely
 * cannot enforce that — it does not depend on the gate engine, deliberately — so before ADR-0024
 * `aldus status` reported a stage as blocked and `aldus run` executed it anyway, side effects and
 * all. This suite pins both halves of the fix:
 *
 * - a **declared** required gate refuses, and the stage's side effect never runs;
 * - the **undeclared** conservative fallback does *not* refuse, because refusing on a guess would
 *   deadlock every Run that never declared a workflow graph.
 *
 * Every test asserts the side-effect counter, not just the outcome. An exit code cannot prove
 * that nothing happened.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StageDefinition, StageOutcome } from "@aldus-runtime/stage-runner";
import { z } from "zod";

import type { AldusServices } from "../src/services.js";

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
const UNRELATED_GATE = "release-publish";

let temp: TempWorkspace;
/** Incremented by every stage in this file, so "did it run?" is answerable. */
let sideEffects: Record<string, number>;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  sideEffects = {};
});

afterEach(async () => {
  await temp.cleanup();
});

/**
 * A stage that records having run.
 *
 * `requiredGates` is passed through verbatim, including `undefined`, because the difference
 * between "declared none" and "not declared" is the whole subject of this file.
 */
function countingStage(
  id: string,
  requiredGates?: readonly string[],
): StageDefinition<unknown, unknown> {
  return {
    id,
    version: "1",
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "not_idempotent", reason: "stands in for irreversible work" },
    ...(requiredGates !== undefined ? { requiredGates } : {}),
    execute: (): Promise<StageOutcome<unknown>> => {
      sideEffects[id] = (sideEffects[id] ?? 0) + 1;
      return Promise.resolve({ kind: "completed", output: { ran: true } });
    },
  };
}

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

describe("a declared required gate stops the stage", () => {
  it("refuses, and the side effect never runs", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("paid.work", [GATE])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const result = await services.runStage({ runId, stageId: "paid.work" });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("stage_gate_unsatisfied");
    expect(result.refusal.explanation).toContain(GATE);
    expect(result.refusal.details).toMatchObject({ runId, stageId: "paid.work", gateId: GATE });

    // The point of the whole issue: an exit code alone would not prove this.
    expect(sideEffects["paid.work"]).toBeUndefined();
  });

  it("runs once the gate is approved", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("paid.work", [GATE])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });
    await services.approve({ runId, gateId: GATE });

    const result = await services.runStage({ runId, stageId: "paid.work" });

    expect(result.outcome).toBe("ok");
    expect(sideEffects["paid.work"]).toBe(1);
  });

  it("refuses a retry on the same condition", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("paid.work", [GATE])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const result = await services.retryStage({ runId, stageId: "paid.work" });

    expect(result.outcome).toBe("refused");
    expect(sideEffects["paid.work"]).toBeUndefined();
  });

  it("is not bypassed by force", async () => {
    // `force` exists to take over a stale claimed stage (ADR-0008). Overriding a human gate is a
    // different act, and §13 does not permit it.
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("paid.work", [GATE])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const result = await services.runStage({ runId, stageId: "paid.work", force: true });

    expect(result.outcome).toBe("refused");
    expect(sideEffects["paid.work"]).toBeUndefined();
  });

  it("refuses when the declared gate is not registered at all", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("paid.work", ["nonexistent-gate"])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const result = await services.runStage({ runId, stageId: "paid.work" });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.explanation).toContain("not registered");
    expect(sideEffects["paid.work"]).toBeUndefined();
  });
});

describe("declaring no gates keeps a stage runnable", () => {
  it("runs while an unrelated gate is pending", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("free.work", [])),
      gates: [gateDefinition(UNRELATED_GATE)],
      subjects: subjectsForAll([UNRELATED_GATE]),
    });

    const result = await services.runStage({ runId, stageId: "free.work" });

    expect(result.outcome).toBe("ok");
    expect(sideEffects["free.work"]).toBe(1);
  });
});

describe("the conservative fallback warns but does not refuse", () => {
  // The whole fix in one test: three stages, one pending blocking gate.
  it("refuses only the stage that declared the gate", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(
        countingStage("declares.gate", [GATE]),
        countingStage("declares.none", []),
        countingStage("declares.nothing"),
      ),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const declared = await services.runStage({ runId, stageId: "declares.gate" });
    const empty = await services.runStage({ runId, stageId: "declares.none" });
    const undeclared = await services.runStage({ runId, stageId: "declares.nothing" });

    expect(declared.outcome).toBe("refused");
    expect(empty.outcome).toBe("ok");
    expect(undeclared.outcome).toBe("ok");

    expect(sideEffects["declares.gate"]).toBeUndefined();
    expect(sideEffects["declares.none"]).toBe(1);
    expect(sideEffects["declares.nothing"]).toBe(1);
  });

  it("still reports the undeclared stage as blocked in status", async () => {
    // Advisory, not silent. The operator is told the runtime cannot tell whether the gate
    // applies; they are simply not prevented from proceeding.
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("declares.gate", [GATE]), countingStage("declares.nothing")),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const status = await services.status(runId);
    expect(status.outcome).toBe("ok");
    if (status.outcome !== "ok") return;

    const blocked = status.data.focused?.plan.blocked ?? [];
    const undeclared = blocked.find((entry) => entry.stageId === "declares.nothing");
    const declared = blocked.find((entry) => entry.stageId === "declares.gate");

    expect(undeclared?.enforcement).toBe("advisory");
    expect(undeclared?.reason).toContain("not declared in the workflow graph");
    expect(declared?.enforcement).toBe("enforced");
  });

  /**
   * The deadlock this fix exists to avoid.
   *
   * Every gate is unsatisfied when a Run starts, and the subjects a gate binds are produced by
   * stages. If the conservative fallback refused, an adopter who never declared a workflow graph
   * would find every stage refused with no way out — on first upgrade, with a message telling
   * them to decide a gate they cannot yet produce evidence for.
   *
   * Written to fail loudly if anyone later makes the conservative default enforceable.
   */
  it("leaves every stage runnable when nothing declares anything", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("first"), countingStage("second"), countingStage("third")),
      gates: [gateDefinition(GATE), gateDefinition(UNRELATED_GATE)],
      subjects: subjectsForAll([GATE, UNRELATED_GATE]),
    });

    for (const stageId of ["first", "second", "third"]) {
      const result = await services.runStage({ runId, stageId });
      expect(result.outcome, `${stageId} must remain runnable`).toBe("ok");
      expect(sideEffects[stageId]).toBe(1);
    }
  });
});

describe("status and run agree", () => {
  it("refuses with the same reason status prints", async () => {
    // The design rests on this: one policy function answers both, so the operator never reads
    // one thing and is told another a command later.
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("paid.work", [GATE])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const status = await services.status(runId);
    const run = await services.runStage({ runId, stageId: "paid.work" });

    expect(status.outcome).toBe("ok");
    expect(run.outcome).toBe("refused");
    if (status.outcome !== "ok" || run.outcome !== "refused") return;

    const blocked = status.data.focused?.plan.blocked.find(
      (entry) => entry.stageId === "paid.work" && entry.kind === "run-stage",
    );
    expect(blocked?.reason).toBe(run.refusal.explanation);
  });
});

describe("an undecidable gate is distinguished from an undecided one (#57)", () => {
  // The same separation ADR-0024 made between "decide this gate" and "I cannot tell whether this
  // gate applies", one layer further in. A gate with no subjects at all cannot be decided, so
  // telling an operator to decide it is advice they cannot act on — and when the refused stage is
  // what produces those subjects, it is advice they can never act on.
  it("says the gate cannot be decided yet when nothing has supplied its subjects", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("paid.work", [GATE])),
      gates: [gateDefinition(GATE)],
      subjects: {}, // nothing has produced what the gate binds
    });

    const result = await services.runStage({ runId, stageId: "paid.work" });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.explanation).toContain("cannot be decided yet");
    expect(result.refusal.explanation).toContain("gated on its own output");
    expect(result.refusal.details).toMatchObject({ gateUndecidable: true });
    expect(sideEffects["paid.work"]).toBeUndefined();
  });

  it("does not say it when the gate has subjects and is merely undecided", async () => {
    // The ordinary case. Over-reporting would make the hint noise an operator learns to skip,
    // which is how it stops working on the day it matters.
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("paid.work", [GATE])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const result = await services.runStage({ runId, stageId: "paid.work" });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.explanation).not.toContain("cannot be decided yet");
    expect(result.refusal.details).not.toMatchObject({ gateUndecidable: true });
  });

  it("does not say it for an ordering block, which is always actionable", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(countingStage("first", []), countingStage("second", [])),
      gates: [],
      subjects: {},
      workflow: { stages: [{ stageId: "first" }, { stageId: "second", after: ["first"] }] },
    });

    const result = await services.runStage({ runId, stageId: "second" });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("stage_predecessor_unmet");
    expect(result.refusal.explanation).not.toContain("cannot be decided yet");
  });
});
