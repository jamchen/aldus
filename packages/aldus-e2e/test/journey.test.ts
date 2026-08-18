/**
 * One Episode, end to end, through every package the operator surface reaches.
 *
 * Each package already tests its own happy path, so a second happy path would add nothing. What
 * only appears here is **sequence**: whether an artifact registered by a stage is the artifact the
 * gate binds, whether an approval recorded through the gate engine is the approval the synthesis
 * authorizer reads, whether a take recorded against a plan is the take the release bundle's
 * lineage points at. Those seams have no owner in a per-package suite.
 *
 * The journey is written as one ordered `describe` with shared state, deliberately. Splitting it
 * into independent tests would mean re-driving the whole stack for each assertion, and the cost
 * would be paid in exactly the coupling this file exists to exercise.
 */

import { readFile } from "node:fs/promises";

import { digestSubjectValue } from "@aldus-runtime/gate-engine";
import { isAccepted, isPaid, isRejected } from "@aldus-runtime/tts-ledger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTENT_FREEZE_GATE,
  NARRATION_STAGE,
  OPERATOR,
  PERFORMANCE_FREEZE_GATE,
  PUBLISH_GATE,
  RENDER_STAGE,
  REVIEW_STAGE,
  RUN_ID,
  SHOW_ID,
  UPLOAD_GATE,
  aBundle,
  aGrant,
  aPlan,
  aScript,
  journeyGates,
  journeySubjects,
  makeStack,
  producingStage,
  gatedStage,
  type Stack,
} from "../src/index.js";

const PLAN = aPlan();
const CONTENT = "the-frozen-content";
const RENDER = "render-a";

let stack: Stack;
/** The narration artifact's id, captured in step 2 and used from step 7 onward. */
let narrationArtifactId = "";
/** The take ids recorded in step 6. */
const takeIds: Record<string, string> = {};

beforeAll(async () => {
  stack = await makeStack({
    gates: journeyGates(PLAN),
    // A factory, because a stage that registers artifacts needs the registry the context builds.
    // The loop is closed here rather than by borrowing a registry from a throwaway context, which
    // would bind the stages to a different workspace root than the one under test.
    stages: (registry, workingRoot) => [
      producingStage(NARRATION_STAGE, {
        workingRoot,
        relativePath: "narration.txt",
        contents: "The first line.\nThe second line.\n",
        kind: "ApprovedNarration",
        mediaType: "text/plain",
        reconstructability: "source",
        registry,
      }),
      gatedStage(REVIEW_STAGE, CONTENT_FREEZE_GATE, [digestSubjectValue(CONTENT)]),
      producingStage(RENDER_STAGE, {
        workingRoot,
        relativePath: "render.bin",
        contents: "rendered bytes",
        kind: "RenderManifest",
        mediaType: "application/octet-stream",
        // The final render is irreplaceable: §8.1 requires it archived before any cleanup.
        reconstructability: "irreplaceable",
        registry,
      }),
    ],
  });
  stack.state.subjects = journeySubjects({
    content: CONTENT,
    render: RENDER,
    plan: PLAN,
    grant: aGrant(),
  });
});

afterAll(async () => {
  await stack.cleanup();
});

describe("1. a workspace and a Run", () => {
  it("initialises an Episode with a canonical identity (§6.1)", async () => {
    const result = await stack.services.init({
      episode: { showId: SHOW_ID, slug: "episode-a", title: "Example Episode A" },
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.episode?.episodeId).toBe("show:example-show:episode:episode-a");
  });

  it("starts a Run", async () => {
    const result = await stack.services.startRun({
      workflowId: "workflow-a",
      workflowVersion: "1",
      runId: RUN_ID,
      codeRevision: "revision-a",
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
  });

  it("explains the situation rather than presenting a data dump (§24)", async () => {
    const result = await stack.services.status();
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    const plan = result.data.focused?.plan;

    // NOTE: `next` is empty here, and that is the composed behaviour rather than an oversight in
    // this test. `decideActions` treats *any* unsatisfied blocking gate as blocking *every* unrun
    // stage, and this workflow declares all four gates up front the way an adopter would. So from
    // the first moment, no stage is offered. See `findings.test.ts`, which pins this deliberately.
    //
    // What §24 does still deliver is the second half of its promise: every withheld action carries
    // a reason naming what is blocking it, so an operator is never left guessing.
    expect(plan?.summary).toBeTruthy();
    const runNarration = plan?.blocked.find((entry) => entry.stageId === NARRATION_STAGE);
    expect(runNarration?.reason).toContain(CONTENT_FREEZE_GATE);
  });
});

describe("2. a stage produces a registered artifact (§8, §11)", () => {
  it("runs and succeeds", async () => {
    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: NARRATION_STAGE,
      configuration: { voice: "voice-a" },
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
  });

  it("registered the artifact with its digest and provenance, not just a path (§8.1)", async () => {
    const result = await stack.services.artifacts(RUN_ID);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;

    expect(result.data.records).toHaveLength(1);
    const record = result.data.records[0];
    narrationArtifactId = record?.artifact.artifactId ?? "";

    expect(record?.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.artifact.producerRunId).toBe(RUN_ID);
    expect(record?.artifact.producerStageId).toBe(NARRATION_STAGE);
    // §8.1: an artifact MUST record which stage, run, code revision, and configuration produced
    // it. The registry knows all four only because the stage passed provenance through.
    expect(record?.provenance.codeRevision).toBe("revision-a");
    expect(record?.provenance.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports nothing unregistered, because the stage used the registry (§8.1)", async () => {
    const result = await stack.services.artifacts(RUN_ID);
    if (result.outcome !== "ok") return;
    // The collection file and the registry agree. A stage that only called `recordOutput` would
    // show up here, which is exactly what that field is for.
    expect(result.data.unregistered).toEqual([]);
  });
});

describe("3. the Run halts at a gate rather than proceeding (§11, §13)", () => {
  it("stops, and says so as an outcome rather than an error", async () => {
    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: REVIEW_STAGE,
      actor: OPERATOR,
    });
    // Not `ok`: the stage did not complete. Not a throw either — a halt is recorded, not
    // exceptional (§11).
    expect(result.outcome).toBe("unsuccessful");
  });

  it("now names the gate as the next action, above running anything else (§24)", async () => {
    const result = await stack.services.status(RUN_ID);
    if (result.outcome !== "ok") return;
    const plan = result.data.focused?.plan;
    const first = plan?.next[0];
    expect(first?.gateId).toBe(CONTENT_FREEZE_GATE);
  });

  it("explains why the render stage is not offered, instead of silently omitting it", async () => {
    const result = await stack.services.status(RUN_ID);
    if (result.outcome !== "ok") return;
    const plan = result.data.focused?.plan;
    // §24's harder half: an operator who expected to render must be told why they cannot.
    const blocked = plan?.blocked ?? [];
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((entry) => entry.reason.length > 0)).toBe(true);
  });
});

describe("4. a human decision unblocks it (§3.6, §13.1)", () => {
  it("records a durable GateDecision", async () => {
    const result = await stack.services.approve({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE_GATE,
      comment: "Content reads correctly.",
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.decision).toBe("approved");
    expect(result.data.decisionId).toBeTruthy();

    // The cascade is reported with the decision, so a caller sees what the approval unblocked
    // without a second query (§13.1).
    const freeze = result.data.gates.find((gate) => gate.gateId === CONTENT_FREEZE_GATE);
    // "satisfied", not "approved": the state is derived from the decision plus current subject
    // digests plus upstream gates (ADR-0009), so it says whether the gate currently holds rather
    // than merely what somebody once clicked.
    expect(freeze?.state).toBe("satisfied");
    expect(freeze?.decision?.decidedBy.id).toBe(OPERATOR.id);
  });

  it("lets the render stage run now that the freeze holds", async () => {
    const result = await stack.services.runStage({
      runId: RUN_ID,
      stageId: RENDER_STAGE,
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
  });
});

describe("5. synthesis is refused, then authorized (§13.2)", () => {
  it("records the script and the plan without spending anything", async () => {
    const script = await stack.services.recordPerformanceScript({
      script: aScript(),
      actor: OPERATOR,
    });
    expect(script.outcome).toBe("ok");
    const plan = await stack.services.recordSynthesisPlan({ plan: PLAN, actor: OPERATOR });
    expect(plan.outcome).toBe("ok");
    // Recording a plan is what makes approval possible; it is not approval.
    expect(stack.synthesis.calls).toHaveLength(0);
  });

  it("refuses synthesis before the performance freeze, without reaching the adapter", async () => {
    const result = await stack.services.synthesiseSegment({
      plan: PLAN,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("refused");
    // The assertion that means "no money was spent".
    expect(stack.synthesis.calls).toHaveLength(0);
  });

  it("still refuses when the gate is approved but no ceiling is granted (§19.3)", async () => {
    const decision = await stack.services.approve({
      runId: RUN_ID,
      gateId: PERFORMANCE_FREEZE_GATE,
      actor: OPERATOR,
    });
    expect(decision.outcome).toBe("ok");

    const result = await stack.services.synthesiseSegment({
      plan: PLAN,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("refused");
    expect(stack.synthesis.calls).toHaveLength(0);
  });

  it("synthesises once the grant cites the approval that was actually recorded", async () => {
    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") return;
    const gate = status.data.focused?.gates.find((g) => g.gateId === PERFORMANCE_FREEZE_GATE);
    expect(gate?.decision?.decisionId).toBeTruthy();

    stack.state.grant = aGrant({ decisionId: gate?.decision?.decisionId ?? "" });

    const result = await stack.services.synthesiseSegment({
      plan: PLAN,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
    expect(stack.synthesis.callsFor("seg-1")).toBe(1);
  });

  it("handed the adapter a permit the gateway genuinely issued", () => {
    // A hand-built object shaped like a permit answers false here; membership cannot be forged.
    expect(stack.synthesis.calls.every((call) => call.permitIssued)).toBe(true);
  });

  it("never handed the adapter anything resembling a credential (§19.2)", () => {
    const serialised = JSON.stringify(stack.synthesis.calls);
    for (const forbidden of ["apiKey", "token", "secret", "authorization"]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("6. takes are recorded, judged, and retained (§13.3, §15.1)", () => {
  it("synthesises the second segment too", async () => {
    const result = await stack.services.synthesiseSegment({
      plan: PLAN,
      segmentId: "seg-2",
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    takeIds["seg-2-first"] = result.data.take.takeId;
  });

  it("records a rejection with its reason", async () => {
    const result = await stack.services.decideTake({
      runId: RUN_ID,
      takeId: takeIds["seg-2-first"] ?? "",
      decision: {
        decision: "rejected",
        // §15.1: a rejection needs a reason, because a reasonless one cannot become a repair
        // strategy or a regression-corpus case.
        reason: "The pacing runs ahead of the line.",
        decidedBy: OPERATOR.id,
        decidedAt: "2026-01-01T00:00:00.000Z",
      },
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
  });

  it("regenerates only the rejected segment, leaving the accepted one alone", async () => {
    const before = stack.synthesis.callsFor("seg-1");
    const result = await stack.services.synthesiseSegment({
      plan: PLAN,
      segmentId: "seg-2",
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    takeIds["seg-2-second"] = result.data.take.takeId;
    // §15.1's repair discipline, observed end to end: the unaffected segment was not re-requested.
    expect(stack.synthesis.callsFor("seg-1")).toBe(before);
    expect(stack.synthesis.callsFor("seg-2")).toBe(2);
  });

  it("keeps the rejected take, with its own identity (§15.1)", async () => {
    const result = await stack.services.takes(RUN_ID);
    if (result.outcome !== "ok") return;
    const rejected = result.data.takes.filter(isRejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.takeId).toBe(takeIds["seg-2-first"]);
    // A rejected paid take is evidence, not garbage.
    expect(rejected.every(isPaid)).toBe(true);
  });

  it("accepts the replacement", async () => {
    const result = await stack.services.decideTake({
      runId: RUN_ID,
      takeId: takeIds["seg-2-second"] ?? "",
      decision: {
        decision: "accepted",
        decidedBy: OPERATOR.id,
        decidedAt: "2026-01-01T00:00:00.000Z",
      },
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("ok");
    const takes = await stack.services.takes(RUN_ID);
    if (takes.outcome !== "ok") return;
    expect(takes.data.takes.filter(isAccepted)).toHaveLength(1);
  });
});

describe("7. irreplaceable artifacts are archived before anything is cleaned (§8.1)", () => {
  it("refuses a cleanup while the render is unarchived", async () => {
    const result = await stack.services.planArtifactCleanup(RUN_ID);
    if (result.outcome !== "ok") return;
    // §8.1's ordering requirement, stated as a refusal rather than a warning.
    expect(result.data.safe).toBe(false);
    expect(result.data.blocked.length).toBeGreaterThan(0);
  });

  it("names the unarchived irreplaceable artifact in the report", async () => {
    const result = await stack.services.artifacts(RUN_ID);
    if (result.outcome !== "ok") return;
    expect(result.data.unarchivedIrreplaceable).toHaveLength(1);
    expect(result.data.unarchivedIrreplaceable[0]?.artifact.kind).toBe("RenderManifest");
  });

  it("archives it, and the same cleanup then becomes safe", async () => {
    const archived = await stack.services.archiveIrreplaceable({ runId: RUN_ID, actor: OPERATOR });
    expect(archived.outcome).toBe("ok");

    const plan = await stack.services.planArtifactCleanup(RUN_ID);
    if (plan.outcome !== "ok") return;
    expect(plan.data.safe).toBe(true);
    expect(plan.data.blocked).toEqual([]);
  });

  it("can still recover the archived bytes", async () => {
    const result = await stack.services.artifacts(RUN_ID);
    if (result.outcome !== "ok") return;
    const render = result.data.records.find((r) => r.artifact.kind === "RenderManifest");
    expect(render?.archive?.verified).toBe(true);
  });
});

describe("8. release produces resumable receipts (§17, §13.4)", () => {
  const bundle = aBundle();

  it("refuses publication while only upload is approved (§13.4)", async () => {
    const upload = await stack.services.approve({
      runId: RUN_ID,
      gateId: UPLOAD_GATE,
      actor: OPERATOR,
    });
    expect(upload.outcome).toBe("ok");

    const result = await stack.services.executeRelease({ bundle, actor: OPERATOR });
    // Refused, not unsuccessful: the bundle requires an authority nobody holds, which is a policy
    // answer rather than an operation that ran and failed. Collapsing the two is what makes a CLI
    // unscriptable, so the distinction is load-bearing all the way out to the exit code.
    expect(result.outcome).toBe("refused");
    // The assertion that matters: nothing was published.
    expect(stack.release.executionCount("publish")).toBe(0);
  });

  it("executes fully once publication is approved too", async () => {
    const publish = await stack.services.approve({
      runId: RUN_ID,
      gateId: PUBLISH_GATE,
      actor: OPERATOR,
    });
    expect(publish.outcome).toBe("ok");

    const result = await stack.services.executeRelease({ bundle, actor: OPERATOR });
    expect(result.outcome).toBe("ok");
    expect(stack.release.executionCount("publish")).toBe(1);
  });

  it("did not re-execute the upload that had already succeeded (§19.1)", () => {
    // Reconciliation runs before every execution, so the second call skipped what was already done.
    expect(stack.release.executionCount("upload")).toBe(1);
  });

  it("recorded a receipt per operation (§17)", async () => {
    const result = await stack.services.releaseStatus(RUN_ID);
    if (result.outcome !== "ok") return;
    const ids = new Set(result.data.receipts.map((receipt) => receipt.operation));
    expect(ids.has("media-upload")).toBe(true);
    expect(ids.has("visibility-transition")).toBe(true);
    expect(result.data.failed).toEqual([]);
  });
});

describe("9. the trace answers §20's questions", () => {
  it("says what produced the narration artifact and what it cost", async () => {
    const lineage = await stack.services.artifactLineage(narrationArtifactId);
    expect(lineage.outcome).toBe("ok");
    if (lineage.outcome !== "ok") return;
    expect(lineage.data.producer?.runId).toBe(RUN_ID);
    expect(lineage.data.producer?.stageId).toBe(NARRATION_STAGE);

    const costs = await stack.services.costs(RUN_ID);
    expect(costs.outcome).toBe("ok");
  });

  it("says who approved what, surviving every service call since", async () => {
    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") return;
    const decided = (status.data.focused?.gates ?? []).filter(
      (gate) => gate.decision !== undefined,
    );
    expect(decided.length).toBe(4);
    // §19.2: every mutating decision records who made it. An unattributed approval is not one.
    expect(decided.every((gate) => gate.decision?.decidedBy.id === OPERATOR.id)).toBe(true);
  });

  it("wrote an append-only event log covering the journey (§6.4)", async () => {
    const path = `${stack.root}/.aldus/runs/${RUN_ID}/events.jsonl`;
    const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    const actions = lines.map((line) => (JSON.parse(line) as { action: string }).action);

    // Every state mutation emits an event — not the important ones, every one.
    expect(actions.some((a) => a.startsWith("stage."))).toBe(true);
    expect(actions.some((a) => a.startsWith("gate."))).toBe(true);
    expect(actions.some((a) => a.startsWith("tts."))).toBe(true);
    expect(actions.some((a) => a.startsWith("release."))).toBe(true);

    // Sequence numbers are assigned by the store and are strictly increasing (ADR-0005), which is
    // what makes the log totally ordered regardless of which instance wrote which line.
    const sequences = lines.map((line) => (JSON.parse(line) as { sequence?: number }).sequence);
    const present = sequences.filter((s): s is number => typeof s === "number");
    expect(present).toEqual([...present].sort((a, b) => a - b));
    expect(new Set(present).size).toBe(present.length);
  });
});
