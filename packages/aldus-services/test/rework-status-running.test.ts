/**
 * `reworkStatus` over a Run holding an attempt recorded `running` (#220, ADR-0057).
 *
 * **The wiring, not the decision.** The controller's arm is unit-tested in `rework.test.ts`; the
 * issue's own warning is about this seam — *"the wiring is where this gets decided by accident if
 * nobody decides it deliberately"*. Before this, `reworkStatus` skipped every non-succeeded attempt,
 * so a Run holding a killed evaluation reported *nothing to decide about*, and a Run holding a stuck
 * attempt beside an older clean one reported the clean verdict.
 *
 * The state is written as a stage-state cache with an empty event log, so the running attempt is a
 * durable record read through `StageRunner.stageState` rather than a value handed to the decision.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorRef, ArtifactRef, ReworkPolicy, StageAttempt } from "@aldus-runtime/core";
import { SCHEMA_VERSION } from "@aldus-runtime/core";
import { GateRegistry } from "@aldus-runtime/gate-engine";
import { builders, createTestContext } from "@aldus-runtime/testkit";
import {
  emptyStageState,
  stageStatePathFor,
  writeStageState,
  type AttemptMetadata,
  type StoredStageExecution,
} from "@aldus-runtime/stage-runner";

import { AldusContext } from "../src/context.js";
import { AldusServices } from "../src/services.js";
import {
  costRecord,
  fixedClock,
  makeTempWorkspace,
  OPERATOR,
  type TempWorkspace,
} from "./helpers.js";

const ORACLE = "script.oracle";
const REVISE = "script.revise";
const CANDIDATE = "script-candidate";
const REPORT = "oracle-report";
const A = "a".repeat(64);
const B = "b".repeat(64);
const ACTOR: ActorRef = OPERATOR;

let temp: TempWorkspace;
/** Distinct Run ids within one test: the builders are seeded, so two calls would collide. */
let runs = 0;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  runs = 0;
});

afterEach(async () => {
  await temp.cleanup();
});

const POLICY: ReworkPolicy = {
  schemaVersion: SCHEMA_VERSION,
  policyId: "policy-a",
  stageId: ORACLE,
  repairStageId: REVISE,
  coversFindingClasses: ["comprehension"],
  maxRounds: 3,
  escalateToGateId: "script.freeze",
  candidateArtifactKind: CANDIDATE,
  authorizationId: "decision-a",
  automaticCorrectionHarm: "a wrong repair rewrites narration a host reads aloud",
};

const CTX = createTestContext();

/** Every record is built by the testkit builders, so it validates against Core's own schema. */
const art = (kind: string, sha: string): ArtifactRef =>
  builders.ArtifactRef({ kind, sha256: sha }, CTX);

const META: AttemptMetadata = {
  stageVersion: "1",
  configurationHash: "hash-a",
  configuration: {},
  idempotent: true,
} as unknown as AttemptMetadata;

function attempt(over: Partial<StageAttempt> & { attemptId: string }): StageAttempt {
  const built = builders.StageAttempt({ stageId: ORACLE, actor: ACTOR, ...over }, CTX);
  // A running attempt has not settled, so it holds neither a finish time nor an error. Deleting
  // the builder's defaults rather than overriding them: `exactOptionalPropertyTypes` makes
  // `undefined` a different thing from absent, and the record is what the runner would have left.
  if (built.status === "running") {
    delete (built as { finishedAt?: string }).finishedAt;
    delete (built as { error?: unknown }).error;
  }
  return built;
}

/** A stored execution of the evaluating stage, carrying the attempts a case needs. */
function oracleExecution(
  runId: string,
  attempts: readonly StageAttempt[],
  status: string,
): StoredStageExecution {
  return {
    execution: builders.StageExecution(
      {
        runId,
        stageId: ORACLE,
        status: status as never,
        attempts: attempts as never,
      },
      CTX,
    ),
    metadata: Object.fromEntries(
      attempts.map((entry) => [
        entry.attemptId,
        // The evaluation's observations, so a settled attempt reads as a real verdict rather than
        // as `not_evaluated`. A running attempt has none, which is the honest record.
        entry.status === "succeeded"
          ? { ...META, observations: [], blockingFindingClasses: [] }
          : META,
      ]),
    ) as Record<string, AttemptMetadata>,
  };
}

/** Compose services over a Run whose stage-state cache holds `attempts` for the oracle. */
async function reworkStatusFor(
  attempts: readonly StageAttempt[],
  executionStatus: string,
  costs: readonly { attemptId: string }[] = [],
): Promise<ReturnType<AldusServices["reworkStatus"]> extends Promise<infer R> ? R : never> {
  runs += 1;
  const manifest = builders.RunManifest({ runId: `run-${runs}` }, CTX);
  await temp.workspace.runs.create(manifest);
  const runId = manifest.runId;

  const state = emptyStageState();
  // No stage execution at all when the case has no attempts: an execution record with an empty
  // attempt list is not a shape the runner ever writes, and a fixture the schema rejects would
  // measure the fixture rather than the reading.
  if (attempts.length > 0) state.stages.push(oracleExecution(runId, attempts, executionStatus));
  await writeStageState(stageStatePathFor(temp.workspace, runId), state);

  for (const cost of costs) {
    await temp.workspace.runs.addRecord(runId, "costs", {
      ...costRecord({
        runId,
        billingStatus: "charged",
        actual: { amount: "1.50", currency: "USD" },
      }),
      stageId: ORACLE,
      attemptId: cost.attemptId,
    });
  }

  const context = new AldusContext({
    workspace: temp.workspace,
    gates: GateRegistry.from([]),
    actor: ACTOR,
    reworkPolicies: [POLICY],
    subjects: () => Promise.resolve({}),
    now: fixedClock(),
  });
  return await new AldusServices(context).reworkStatus(runId);
}

const RUNNING = attempt({
  attemptId: "att-10",
  attempt: 10,
  status: "running",
  inputArtifacts: [art(CANDIDATE, A)],
  finishedAt: undefined,
});

const SETTLED_CLEAN = attempt({
  attemptId: "att-9",
  attempt: 9,
  inputArtifacts: [art(CANDIDATE, A)],
  outputArtifacts: [art(REPORT, B)],
});

describe("a Run holding an evaluation attempt recorded running", () => {
  it("previews reconciliation rather than reporting nothing to decide about", async () => {
    const result = await reworkStatusFor([RUNNING], "running");
    if (result.outcome !== "ok") throw new Error(result.outcome);
    const loop = result.data.loops[0];

    expect(loop?.previewUnavailable).toBeUndefined();
    expect(loop?.wouldDecide?.kind).toBe("reconciliation_required");
    if (loop?.wouldDecide?.kind !== "reconciliation_required") return;
    expect(loop.wouldDecide.stageId).toBe(ORACLE);
    expect(loop.wouldDecide.attemptId).toBe("att-10");
    expect(loop.wouldDecide.artifactDigest).toBe(A);
    expect(loop.wouldDecide.explanation).toContain("--force");
  });

  it("attaches the cost records the record attributes to that attempt", async () => {
    // The charged timing from the ruling, read off the durable cost stream by `attemptId` — the
    // only join from a charge to the attempt that incurred it (§19.3). Reported, never compared.
    const result = await reworkStatusFor([RUNNING], "running", [{ attemptId: "att-10" }]);
    if (result.outcome !== "ok") throw new Error(result.outcome);
    const decision = result.data.loops[0]?.wouldDecide;
    if (decision?.kind !== "reconciliation_required") throw new Error(String(decision?.kind));

    expect(decision.recordedCostIds).toHaveLength(1);
    // And the same input with no charge is the other legal timing, in the same class.
    const quiet = await reworkStatusFor([RUNNING], "running");
    if (quiet.outcome !== "ok") throw new Error(quiet.outcome);
    const other = quiet.data.loops[0]?.wouldDecide;
    if (other?.kind !== "reconciliation_required") throw new Error(String(other?.kind));
    expect(other.recordedCostIds).toEqual([]);
    expect(other.explanation).toBe(decision.explanation);
  });

  it("does not attribute another attempt's charge to the running one", async () => {
    const result = await reworkStatusFor([SETTLED_CLEAN, RUNNING], "running", [
      { attemptId: "att-9" },
    ]);
    if (result.outcome !== "ok") throw new Error(result.outcome);
    const decision = result.data.loops[0]?.wouldDecide;
    if (decision?.kind !== "reconciliation_required") throw new Error(String(decision?.kind));

    expect(decision.recordedCostIds).toEqual([]);
  });

  it("outranks an older settled attempt whose verdict was clean", async () => {
    // The accident this seam would otherwise produce: a readable clean verdict beside an
    // unreconciled window, previewed as a convergence that releases the next stage.
    const result = await reworkStatusFor([SETTLED_CLEAN, RUNNING], "running");
    if (result.outcome !== "ok") throw new Error(result.outcome);

    expect(result.data.loops[0]?.wouldDecide?.kind).toBe("reconciliation_required");
  });

  it("refuses a preview when the running attempt's candidate is not established", async () => {
    // No subject, no decision. The reason still says a running attempt stands, because that is the
    // fact an operator needs — what must not appear is a notice naming a candidate nobody can check.
    const result = await reworkStatusFor(
      [attempt({ attemptId: "att-10", status: "running", inputArtifacts: [] })],
      "running",
    );
    if (result.outcome !== "ok") throw new Error(result.outcome);
    const loop = result.data.loops[0];

    expect(loop?.wouldDecide).toBeUndefined();
    expect(loop?.previewUnavailable).toContain("att-10");
    expect(loop?.previewUnavailable).toContain("reconciled");
  });

  it("keeps a settled clean evaluation converging when nothing is running", async () => {
    // The negative control, and the one that makes the cases above mean anything: without it they
    // all pass for a wiring that reports reconciliation for every Run.
    const result = await reworkStatusFor([SETTLED_CLEAN], "succeeded");
    if (result.outcome !== "ok") throw new Error(result.outcome);

    expect(result.data.loops[0]?.wouldDecide?.kind).toBe("converged");
  });

  it("keeps the no-attempt Run reporting no preview", async () => {
    const result = await reworkStatusFor([], "never_run");
    if (result.outcome !== "ok") throw new Error(result.outcome);

    expect(result.data.loops[0]?.wouldDecide).toBeUndefined();
    expect(result.data.loops[0]?.previewUnavailable).toContain("no completed attempt");
  });

  it("returns the identical report when the identical durable state is read again", async () => {
    // Criterion 4, at the seam: a restarted process re-reading the same records must reach the
    // same next action, and must not have paid for anything to find out.
    const manifest = builders.RunManifest({ runId: "run-identical" }, CTX);
    await temp.workspace.runs.create(manifest);
    const state = emptyStageState();
    state.stages.push(oracleExecution(manifest.runId, [RUNNING], "running"));
    await writeStageState(stageStatePathFor(temp.workspace, manifest.runId), state);

    const context = new AldusContext({
      workspace: temp.workspace,
      gates: GateRegistry.from([]),
      actor: ACTOR,
      reworkPolicies: [POLICY],
      subjects: () => Promise.resolve({}),
      now: fixedClock(),
    });
    const services = new AldusServices(context);

    const first = await services.reworkStatus(manifest.runId);
    const second = await services.reworkStatus(manifest.runId);
    expect(second).toEqual(first);
  });
});
