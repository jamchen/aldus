/**
 * Behaviours only composition exposes, pinned deliberately.
 *
 * Each case exists because driving the whole stack surfaced something a per-package suite could
 * not, and pinning it means a future change is a deliberate decision with a failing test attached
 * rather than an accident nobody notices.
 *
 * Two kinds of case live here, and each says which it is:
 *
 * - **Fixed** — the first block. Issue #38 was found here, decided in ADR-0021, and these now
 *   assert the corrected behaviour rather than the defect.
 * - **Current behaviour, not endorsed** — the rest. Where a case describes something I think is
 *   wrong, the comment says so plainly, because a test that quietly encodes a bug as an
 *   expectation is worse than no test: it makes the bug load bearing.
 */

import type { GateDefinition } from "@aldus-runtime/gate-engine";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT_FREEZE_GATE,
  NARRATION_STAGE,
  OPERATOR,
  PERFORMANCE_FREEZE_GATE,
  RENDER_STAGE,
  RUN_ID,
  SHOW_ID,
  UPLOAD_GATE,
  aGrant,
  aPlan,
  journeyGates,
  journeySubjects,
  journeyWorkflow,
  makeStack,
  producingStage,
  type Stack,
} from "../src/index.js";

const PLAN = aPlan();

let stack: Stack;

afterEach(async () => {
  await stack.cleanup();
});

/** Start a Run in a workspace with the given gates. */
async function runWith(gates: readonly GateDefinition[]): Promise<Stack> {
  stack = await makeStack({
    gates,
    stages: (registry, workingRoot) => [
      producingStage(NARRATION_STAGE, {
        workingRoot,
        relativePath: "narration.txt",
        contents: "The first line.\n",
        kind: "ApprovedNarration",
        mediaType: "text/plain",
        reconstructability: "source",
        registry,
      }),
    ],
  });
  stack.state.subjects = journeySubjects({
    content: "content-a",
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

describe("only the gates a stage requires block it (§11, ADR-0021)", () => {
  /*
   * WAS A FINDING, NOW FIXED (issue #38, ADR-0021).
   *
   * `decideActions` used to pick a blocker with `gates.find((gate) => gate.blocking)` and apply it
   * to *every* stage that had never run, because nothing in the model said which gates gate which
   * stages. An unrelated pending release gate therefore suppressed unrelated narration work, and
   * §24's promise degraded to "here is why you cannot act" from the first moment of a Run.
   *
   * A workflow now declares its stage↔gate graph, and these cases hold the fixed behaviour: the
   * conservative fallback when nothing is declared, and the narrowed blocking when something is.
   * Both halves matter — the fix is opt-in, so the fallback is as much part of the contract as the
   * improvement.
   */
  it("offers the first stage when no gate is declared", async () => {
    await runWith([]);
    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") return;
    expect(status.data.focused?.plan.next.map((a) => a.stageId)).toContain(NARRATION_STAGE);
  });

  it("still blocks conservatively when gates exist but no graph declares what they gate", async () => {
    await runWith(journeyGates(PLAN));
    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") return;

    // No workflow graph and no stage declaring its gates, so *nothing* is declared and every
    // blocking gate is assumed to gate every stage. Unchanged from before ADR-0021 — an adopter
    // who declares nothing loses nothing.
    // No stage is offered, which is the conservative behaviour this test exists to pin. The
    // gates themselves are now offered (#86): under the conservative reading every blocking gate
    // gates every stage, so deciding one is exactly what moves the Run — and reporting "nothing
    // is safe to do" while naming a gate as the blocker was a false statement, not a cautious one.
    expect(status.data.focused?.plan.next.filter((a) => a.kind === "run-stage")).toEqual([]);
    expect(status.data.focused?.plan.next.every((a) => a.kind === "approve-gate")).toBe(true);
    const blocked = status.data.focused?.plan.blocked.find((e) => e.stageId === NARRATION_STAGE);
    expect(blocked?.reason).toMatch(/is blocking/i);
    // The graph hint belongs only where a graph exists and this stage was left out of it.
    // Suggesting one when the adopter has declared nothing at all would be noise.
    expect(blocked?.reason).not.toMatch(/not declared in the workflow graph/i);
  });

  it("offers narration despite pending release gates, once the graph says they are unrelated", async () => {
    // The regression, fixed. Narration requires no gate; the release gates are pending and
    // blocking; narration is offered anyway because the graph says they do not gate it.
    stack = await makeStack({
      gates: journeyGates(PLAN),
      workflow: journeyWorkflow(),
      stages: (registry, workingRoot) => [
        producingStage(NARRATION_STAGE, {
          workingRoot,
          relativePath: "narration.txt",
          contents: "The first line.\n",
          kind: "ApprovedNarration",
          mediaType: "text/plain",
          reconstructability: "source",
          registry,
        }),
      ],
    });
    stack.state.subjects = journeySubjects({
      content: "content-a",
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

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") return;
    expect(status.data.focused?.plan.next.map((a) => a.stageId)).toContain(NARRATION_STAGE);

    // The release gates are still reported as blocking what they authorize — narrowing which
    // stages they gate must not hide that publishing is unavailable.
    expect(status.data.focused?.plan.blocked.some((entry) => entry.gateId === UPLOAD_GATE)).toBe(
      true,
    );
  });

  it("offers the stage once every declared gate is satisfied, graph or not", async () => {
    await runWith(journeyGates(PLAN));
    for (const gateId of [CONTENT_FREEZE_GATE, PERFORMANCE_FREEZE_GATE, UPLOAD_GATE]) {
      await stack.services.approve({ runId: RUN_ID, gateId, actor: OPERATOR });
    }
    // The publish gate depends on upload, so approving upload lets it be decided too.
    await stack.services.approve({ runId: RUN_ID, gateId: "release-publish", actor: OPERATOR });

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") return;
    expect(status.data.focused?.plan.next.map((a) => a.stageId)).toContain(NARRATION_STAGE);
  });
});

describe("a stage must be handed the registry by its adopter", () => {
  /*
   * FINDING — a rough edge rather than a defect, but worth knowing before writing an integration.
   *
   * `StageContext` gives a stage `recordOutput(artifact)`, which records an `ArtifactRef` onto the
   * attempt. It does **not** give the stage the `ArtifactRegistry`, so hashing bytes, recording
   * provenance, and taking archival custody all require the adopter to close the stage over a
   * registry it obtained from the context — which cannot exist until the context does.
   *
   * That is defensible under ADR-0015 (the adopter supplies concrete pieces; Aldus wires them),
   * and `ArtifactReport.unregistered` exists precisely to surface a stage that recorded without
   * registering. But it is a loop every adopter has to discover, and `makeStack` in this package
   * needed a factory to close it.
   */
  it("surfaces an artifact recorded on the attempt but never registered", async () => {
    await runWith([]);
    await stack.services.runStage({ runId: RUN_ID, stageId: NARRATION_STAGE, actor: OPERATOR });

    const before = await stack.services.artifacts(RUN_ID);
    if (before.outcome !== "ok") return;
    // This stage did register, so nothing is unregistered. The field's value is that a stage which
    // only called `recordOutput` would appear here rather than looking registered.
    expect(before.data.unregistered).toEqual([]);
    expect(before.data.records).toHaveLength(1);
  });
});

describe("release bundles are caller-supplied values, not stored state", () => {
  /*
   * FINDING — a real constraint on the CLI and MCP surfaces (item 4 of #27).
   *
   * Every release service takes the whole `ReleaseBundle` as an argument; nothing persists it. So
   * an operator cannot say "execute the release for this Run" — they must reconstruct the same
   * bundle, and a bundle that differs produces different idempotency keys and therefore different
   * receipts.
   *
   * Receipts are stored, so `releaseStatus(runId)` works without a bundle. But
   * `releaseBundleStatus`, `reconcileRelease`, and `executeRelease` all need one, which means the
   * adapter surfaces have to get a bundle from somewhere the runtime does not provide.
   */
  it("answers releaseStatus from stored receipts without a bundle", async () => {
    await runWith(journeyGates(PLAN));
    const status = await stack.services.releaseStatus(RUN_ID);
    expect(status.outcome).toBe("ok");
    if (status.outcome !== "ok") return;
    expect(status.data.receipts).toEqual([]);
  });
});

describe("anonymous mutations are refused (§19.2)", () => {
  it("refuses to run a stage with no actor anywhere", async () => {
    stack = await makeStack({
      actor: null,
      stages: (registry, workingRoot) => [
        producingStage(NARRATION_STAGE, {
          workingRoot,
          relativePath: "narration.txt",
          contents: "x",
          kind: "ApprovedNarration",
          mediaType: "text/plain",
          reconstructability: "source",
          registry,
        }),
      ],
    });
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    await stack.services.startRun({
      workflowId: "workflow-a",
      workflowVersion: "1",
      runId: RUN_ID,
      actor: OPERATOR,
    });

    // §19.2: mutating actions record actor identity. An unattributed attempt is not one.
    await expect(
      stack.services.runStage({ runId: RUN_ID, stageId: NARRATION_STAGE }),
    ).rejects.toThrow();
  });

  it("still answers status without an actor, because reading is not mutating (§24)", async () => {
    stack = await makeStack({ actor: null });
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    const status = await stack.services.status();
    // An operator must be able to see where things stand before configuring an identity.
    expect(status.outcome).toBe("ok");
  });
});

describe("a declared gate stops the stage from running (§11, issue #45, ADR-0024)", () => {
  /*
   * WAS A FINDING, NOW FIXED (issue #45, ADR-0024), reported by the first external adopter.
   *
   * `status` reported a stage as blocked and `aldus run` executed it anyway — side effects and
   * all. §11 requires a stage to "stop at required gates", and recording `waiting_for_gate`
   * afterwards is not stopping. Only composition shows it: the runner cannot evaluate a gate, and
   * the gate engine never sees the run request, so the gap lives precisely where the two meet.
   */
  it("refuses a stage whose declared gate is unsatisfied, and runs it once approved", async () => {
    stack = await makeStack({
      gates: journeyGates(PLAN),
      workflow: journeyWorkflow(),
      stages: (registry, workingRoot) => [
        producingStage(RENDER_STAGE, {
          workingRoot,
          relativePath: "render.txt",
          contents: "rendered\n",
          kind: "RenderManifest",
          mediaType: "text/plain",
          reconstructability: "reproducible",
          registry,
        }),
      ],
    });
    stack.state.subjects = journeySubjects({
      content: "content-a",
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

    // journeyWorkflow declares RENDER_STAGE as requiring the content freeze, which is pending.
    const refused = await stack.services.runStage({ runId: RUN_ID, stageId: RENDER_STAGE });
    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.refusal.reason).toBe("stage_gate_unsatisfied");
      expect(refused.refusal.explanation).toContain(CONTENT_FREEZE_GATE);
    }

    // Nothing ran, so no artifact was produced — the assertion that matters, because a render
    // against an unapproved script is exactly the irreversible work this prevents.
    const before = await stack.services.artifacts(RUN_ID);
    if (before.outcome === "ok") expect(before.data.artifacts).toHaveLength(0);

    await stack.services.approve({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE_GATE,
      actor: OPERATOR,
    });

    const allowed = await stack.services.runStage({ runId: RUN_ID, stageId: RENDER_STAGE });
    expect(allowed.outcome).toBe("ok");

    const after = await stack.services.artifacts(RUN_ID);
    if (after.outcome === "ok") expect(after.data.artifacts.length).toBeGreaterThan(0);
  });

  it("leaves an undeclared workflow entirely runnable, so an upgrade cannot deadlock it", async () => {
    // The conservative fallback is a hint, never enforcement. Every gate is unsatisfied when a Run
    // starts and the subjects gates bind are produced by stages, so refusing on the fallback would
    // refuse every stage in a workflow that declared nothing — with no way out (ADR-0024).
    await runWith(journeyGates(PLAN));

    const status = await stack.services.status(RUN_ID);
    if (status.outcome === "ok") {
      const blocked = status.data.focused?.plan.blocked.find((e) => e.stageId === NARRATION_STAGE);
      expect(blocked?.enforcement).toBe("advisory");
    }

    const result = await stack.services.runStage({ runId: RUN_ID, stageId: NARRATION_STAGE });
    expect(result.outcome, "an undeclared workflow must stay runnable").toBe("ok");
  });
});
