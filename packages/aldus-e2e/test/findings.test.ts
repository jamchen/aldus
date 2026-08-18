/**
 * Behaviours only composition exposes, pinned deliberately.
 *
 * Everything here is **current behaviour, not endorsed behaviour**. Each case exists because
 * driving the whole stack surfaced something a per-package suite could not, and pinning it means
 * a future change to any of these is a deliberate decision with a failing test attached rather
 * than an accident nobody notices.
 *
 * Where a case describes something I think is wrong, the comment says so plainly. A test that
 * quietly encodes a bug as an expectation is worse than no test, because it makes the bug load
 * bearing.
 */

import type { GateDefinition } from "@aldus-runtime/gate-engine";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT_FREEZE_GATE,
  NARRATION_STAGE,
  OPERATOR,
  PERFORMANCE_FREEZE_GATE,
  RUN_ID,
  SHOW_ID,
  UPLOAD_GATE,
  aGrant,
  aPlan,
  journeyGates,
  journeySubjects,
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

describe("an unsatisfied gate blocks every unrun stage, related or not", () => {
  /*
   * FINDING — worth a decision, and in my view a defect.
   *
   * `decideActions` picks a blocker with `gates.find((gate) => gate.blocking)` and uses it to
   * block *every* stage that has never run. There is no association between a gate and the stages
   * it actually gates, so an unrelated pending gate suppresses unrelated work.
   *
   * It does not show up in `@aldus-runtime/services`' own tests because those register only the
   * gates a scenario needs. It appears here because a realistic workflow declares its gates up
   * front — which is what an adopter would do, and what §11 describes when it calls a workflow "a
   * versioned graph of stages and gates".
   *
   * The consequence is that §24's promise degrades: from the first moment of a Run, `next` is
   * empty and an operator is told only why they cannot act. The `blocked` reasons are accurate and
   * legible, so nothing is *wrong* — it is just much less useful than the design intends.
   *
   * Fixing it needs a stage↔gate association the model does not currently have, which is why I
   * have reported rather than attempted it.
   */
  it("offers the first stage when no gate is declared", async () => {
    await runWith([]);
    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") return;
    expect(status.data.focused?.plan.next.map((a) => a.stageId)).toContain(NARRATION_STAGE);
  });

  it("offers nothing once an unrelated release gate is declared", async () => {
    await runWith(journeyGates(PLAN));
    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") return;

    // The stage has nothing to do with the release gates, and is suppressed by them anyway.
    expect(status.data.focused?.plan.next).toEqual([]);
    const blocked = status.data.focused?.plan.blocked.find((e) => e.stageId === NARRATION_STAGE);
    expect(blocked).toBeDefined();
    // The reason is at least legible, which is what keeps this a usability defect rather than a
    // correctness one.
    expect(blocked?.reason).toMatch(/blocking/i);
  });

  it("offers the stage again once every declared gate is satisfied", async () => {
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
