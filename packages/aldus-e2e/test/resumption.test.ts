/**
 * Resumption across a restart (architecture contract §3.4, §5.1).
 *
 * §3.4: "No Claude Code, Codex, or API-agent session may be the sole storage location of
 * production state, decisions, or approved artifacts." §5.1: "long pauses between stages are
 * normal."
 *
 * Every other suite in the repository — including the composed ones — drives a single
 * `AldusServices` instance from start to finish, so anything held in memory works exactly as well
 * as anything written to disk. This file is the only place that difference is observable: each
 * scenario throws the services away mid-flow and rebuilds them over the same directory.
 *
 * `stack.restart()` discards the workspace, registry, gate engine, ledger, and executor. What
 * survives is the directory and the adopter's adapters — which is what survives a real process
 * exit too.
 */

import { digestSubjectValue } from "@aldus-runtime/gate-engine";
import { isRejected } from "@aldus-runtime/tts-ledger";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT_FREEZE_GATE,
  NARRATION_STAGE,
  OPERATOR,
  PERFORMANCE_FREEZE_GATE,
  PUBLISH_GATE,
  REVIEW_STAGE,
  RUN_ID,
  SHOW_ID,
  UPLOAD_GATE,
  aBundle,
  aGrant,
  aPlan,
  aScript,
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

/** A stack with the narration and review stages, seeded with an Episode and a Run. */
async function seeded(): Promise<Stack> {
  stack = await makeStack({
    gates: journeyGates(PLAN),
    stages: (registry, workingRoot) => [
      producingStage(NARRATION_STAGE, {
        workingRoot,
        relativePath: "narration.txt",
        contents: "The first line.\n",
        kind: "ApprovedNarration",
        mediaType: "text/plain",
        reconstructability: "irreplaceable",
        registry,
      }),
      gatedStage(REVIEW_STAGE, CONTENT_FREEZE_GATE, [digestSubjectValue(CONTENT)]),
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
    actor: OPERATOR,
  });
  return stack;
}

describe("Run and stage state", () => {
  it("sees the Run and its completed stage after a restart", async () => {
    await seeded();
    await stack.services.runStage({ runId: RUN_ID, stageId: NARRATION_STAGE, actor: OPERATOR });

    const fresh = stack.restart();

    const status = await fresh.status(RUN_ID);
    expect(status.outcome).toBe("ok");
    if (status.outcome !== "ok") return;
    const stage = status.data.focused?.stages.find((s) => s.stageId === NARRATION_STAGE);
    expect(stage?.status).toBe("succeeded");
  });

  it("keeps a halted stage halted, rather than forgetting it was waiting", async () => {
    await seeded();
    await stack.services.runStage({ runId: RUN_ID, stageId: REVIEW_STAGE, actor: OPERATOR });

    const fresh = stack.restart();

    const status = await fresh.status(RUN_ID);
    if (status.outcome !== "ok") return;
    const stage = status.data.focused?.stages.find((s) => s.stageId === REVIEW_STAGE);
    expect(stage?.status).toBe("waiting_for_gate");
    // And the next action still names the gate, so the operator picking this up cold is told the
    // same thing the operator who left was told (§24).
    expect(status.data.focused?.plan.next[0]?.gateId).toBe(CONTENT_FREEZE_GATE);
  });
});

describe("Gate decisions (§3.6, §13)", () => {
  it("survives a restart, so an approval does not depend on a session remembering it", async () => {
    await seeded();
    await stack.services.approve({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE_GATE,
      comment: "Reads correctly.",
      actor: OPERATOR,
    });

    const fresh = stack.restart();

    const status = await fresh.status(RUN_ID);
    if (status.outcome !== "ok") return;
    const gate = status.data.focused?.gates.find((g) => g.gateId === CONTENT_FREEZE_GATE);
    expect(gate?.state).toBe("satisfied");
    expect(gate?.decision?.decidedBy.id).toBe(OPERATOR.id);
    expect(gate?.decision?.comment).toBe("Reads correctly.");
  });

  it("re-derives staleness after a restart, rather than trusting the stored verdict", async () => {
    await seeded();
    await stack.services.approve({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE_GATE,
      actor: OPERATOR,
    });

    // The content changes after approval — §13.1's invalidation case.
    stack.state.subjects = journeySubjects({
      content: "the-content-changed-underneath",
      render: "render-a",
      plan: PLAN,
      grant: aGrant(),
    });

    const fresh = stack.restart();

    const status = await fresh.status(RUN_ID);
    if (status.outcome !== "ok") return;
    const gate = status.data.focused?.gates.find((g) => g.gateId === CONTENT_FREEZE_GATE);
    // The decision is still on disk; the *state* is recomputed from it plus current digests
    // (ADR-0009). A stored "approved" flag would have survived the change and lied.
    expect(gate?.state).toBe("stale");
    expect(gate?.decision).toBeDefined();

    // And a stale approval is the most urgent thing an operator is shown, because it still reads
    // as approved to anyone skimming (§24).
    expect(status.data.focused?.plan.next[0]?.gateId).toBe(CONTENT_FREEZE_GATE);
  });
});

describe("Artifacts (§8)", () => {
  it("keeps registry provenance and archival state across a restart", async () => {
    await seeded();
    await stack.services.runStage({ runId: RUN_ID, stageId: NARRATION_STAGE, actor: OPERATOR });
    await stack.services.archiveIrreplaceable({ runId: RUN_ID, actor: OPERATOR });

    const fresh = stack.restart();

    const result = await fresh.artifacts(RUN_ID);
    if (result.outcome !== "ok") return;
    const record = result.data.records[0];
    expect(record?.provenance.codeRevision).toBe("revision-a");
    expect(record?.archive?.verified).toBe(true);
    // Nothing irreplaceable is left unarchived, so a cleanup is safe — a fact the new instance
    // derived from disk rather than remembered.
    expect(result.data.unarchivedIrreplaceable).toEqual([]);
  });

  it("answers lineage questions from a fresh instance (§20)", async () => {
    await seeded();
    await stack.services.runStage({ runId: RUN_ID, stageId: NARRATION_STAGE, actor: OPERATOR });
    const before = await stack.services.artifacts(RUN_ID);
    if (before.outcome !== "ok") return;
    const artifactId = before.data.records[0]?.artifact.artifactId ?? "";

    const fresh = stack.restart();

    const lineage = await fresh.artifactLineage(artifactId);
    expect(lineage.outcome).toBe("ok");
    if (lineage.outcome !== "ok") return;
    expect(lineage.data.producer?.stageId).toBe(NARRATION_STAGE);
  });
});

describe("The TTS ledger (§15)", () => {
  it("keeps takes, their decisions, and their lineage across a restart", async () => {
    await seeded();
    await stack.services.recordPerformanceScript({ script: aScript(), actor: OPERATOR });
    await stack.services.recordSynthesisPlan({ plan: PLAN, actor: OPERATOR });

    const decision = await stack.services.approve({
      runId: RUN_ID,
      gateId: PERFORMANCE_FREEZE_GATE,
      actor: OPERATOR,
    });
    if (decision.outcome !== "ok") return;
    stack.state.grant = aGrant({ decisionId: decision.data.decisionId });

    const synthesised = await stack.services.synthesiseSegment({
      plan: PLAN,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    if (synthesised.outcome !== "ok") return;
    await stack.services.decideTake({
      runId: RUN_ID,
      takeId: synthesised.data.take.takeId,
      decision: {
        decision: "rejected",
        reason: "Too fast.",
        decidedBy: OPERATOR.id,
        decidedAt: "2026-01-01T00:00:00.000Z",
      },
      actor: OPERATOR,
    });

    const fresh = stack.restart();

    const takes = await fresh.takes(RUN_ID);
    expect(takes.outcome).toBe("ok");
    if (takes.outcome !== "ok") return;
    // §15.1 requires a rejected paid take to be retained. Retained *where* is the question a
    // restart answers: on disk, not in the instance that recorded it.
    expect(takes.data.takes.filter(isRejected)).toHaveLength(1);
    expect(takes.data.takes[0]?.decision?.reason).toBe("Too fast.");
  });

  it("still refuses synthesis after a restart when the approval has drifted (§13.2)", async () => {
    await seeded();
    await stack.services.recordSynthesisPlan({ plan: PLAN, actor: OPERATOR });
    const decision = await stack.services.approve({
      runId: RUN_ID,
      gateId: PERFORMANCE_FREEZE_GATE,
      actor: OPERATOR,
    });
    if (decision.outcome !== "ok") return;
    stack.state.grant = aGrant({ decisionId: decision.data.decisionId });

    // The plan changes after approval. §13.2: the authorization is void the moment a bound value
    // moves, and a restart must not launder that away.
    const drifted = aPlan({
      segments: [{ segmentId: "seg-1", text: { raw: "Something else entirely." } }],
    });

    const fresh = stack.restart();

    const result = await fresh.synthesiseSegment({
      plan: drifted,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    expect(result.outcome).toBe("refused");
    expect(stack.synthesis.calls).toHaveLength(0);
  });
});

describe("Release receipts (§17, §19.1)", () => {
  it("resumes a half-executed bundle without repeating what already succeeded", async () => {
    // The upload succeeds and the publish fails, leaving the bundle genuinely half-done — which
    // is §19.1's "recovery from partial success", and the state a crash actually leaves behind.
    stack = await makeStack({
      gates: journeyGates(PLAN),
      releaseOutcomes: {
        publish: { status: "failed", message: "The destination was unreachable.", retryable: true },
      },
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
      actor: OPERATOR,
    });
    await stack.services.approve({ runId: RUN_ID, gateId: UPLOAD_GATE, actor: OPERATOR });
    await stack.services.approve({ runId: RUN_ID, gateId: PUBLISH_GATE, actor: OPERATOR });

    const bundle = aBundle();
    const first = await stack.services.executeRelease({ bundle, actor: OPERATOR });
    expect(first.outcome).toBe("unsuccessful");
    expect(stack.release.executionCount("upload")).toBe(1);
    expect(stack.release.executionCount("publish")).toBe(1);

    const fresh = stack.restart();

    // Re-executing after a restart: the successful upload is skipped because reconciliation reads
    // its receipt from disk, and only the failed operation is retried. An instance that had lost
    // the receipts would upload twice.
    await fresh.executeRelease({ bundle, actor: OPERATOR });
    expect(stack.release.executionCount("upload")).toBe(1);
    expect(stack.release.executionCount("publish")).toBe(2);
  });

  it("reports the stored receipts from a fresh instance (§20)", async () => {
    await seeded();
    await stack.services.approve({ runId: RUN_ID, gateId: UPLOAD_GATE, actor: OPERATOR });
    await stack.services.approve({ runId: RUN_ID, gateId: PUBLISH_GATE, actor: OPERATOR });
    await stack.services.executeRelease({ bundle: aBundle(), actor: OPERATOR });

    const fresh = stack.restart();

    const status = await fresh.releaseStatus(RUN_ID);
    expect(status.outcome).toBe("ok");
    if (status.outcome !== "ok") return;
    expect(status.data.receipts.length).toBeGreaterThan(0);
    expect(status.data.failed).toEqual([]);
  });
});
