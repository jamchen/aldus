/**
 * Upload and publication are separate operations (architecture contract §13.4, §17).
 *
 * > Release approval MUST bind to the final render, captions, metadata, destination, and
 * > visibility policy. Uploading and making public SHOULD be separate operations.
 *
 * §17 says the same from the other direction: "Upload, review in platform UI, and public release
 * SHOULD be separate states", and §1.1 lists "unsafe all-or-nothing publish operations" among the
 * things V1 must reduce. The failure being guarded against is a single approval that uploads *and*
 * makes public, leaving no moment to look at the result before an audience does.
 *
 * The engine does not know what "upload" or "publish" mean. It knows that an approval authorizes
 * exactly the operations its gate names, which is what makes the separation enforceable rather
 * than merely conventional.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { GateRegistry } from "../src/definition.js";
import { GateEngine } from "../src/engine.js";
import { MemoryGateDecisionStore, MemoryGateEventSink } from "../src/ports.js";
import {
  AT,
  CONTENT_FREEZE,
  EPISODE_ID,
  HUMAN_EAR,
  OPERATOR,
  PERFORMANCE_FREEZE,
  PUBLISH_OPERATION,
  RELEASE_PUBLISH,
  RELEASE_UPLOAD,
  RUN_ID,
  UPLOAD_OPERATION,
  standardGates,
  standardSubjects,
} from "./helpers.js";

let engine: GateEngine;

beforeEach(() => {
  engine = new GateEngine({
    registry: GateRegistry.from(standardGates()),
    decisions: new MemoryGateDecisionStore(),
    events: new MemoryGateEventSink(),
  });
});

async function approve(gateIds: readonly string[], subjects: ReturnType<typeof standardSubjects>) {
  for (const gateId of gateIds) {
    await engine.decide({
      runId: RUN_ID,
      gateId,
      decision: "approved",
      subjects: subjects[gateId] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: `dec-${gateId}`,
    });
  }
}

const THROUGH_UPLOAD = [CONTENT_FREEZE, PERFORMANCE_FREEZE, HUMAN_EAR, RELEASE_UPLOAD];

describe("approving upload does not authorize publication", () => {
  it("authorizes upload once its gate is approved", async () => {
    const subjects = standardSubjects();
    await approve(THROUGH_UPLOAD, subjects);

    const result = await engine.authorize(RUN_ID, UPLOAD_OPERATION, subjects);
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(result.gateId).toBe(RELEASE_UPLOAD);
  });

  // The failure this whole section exists to prevent.
  it("still refuses publication after upload is approved", async () => {
    const subjects = standardSubjects();
    await approve(THROUGH_UPLOAD, subjects);

    const result = await engine.authorize(RUN_ID, PUBLISH_OPERATION, subjects);
    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.explanation).toContain(RELEASE_PUBLISH);
  });

  it("authorizes publication only after its own separate approval", async () => {
    const subjects = standardSubjects();
    await approve([...THROUGH_UPLOAD, RELEASE_PUBLISH], subjects);

    const result = await engine.authorize(RUN_ID, PUBLISH_OPERATION, subjects);
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(result.gateId).toBe(RELEASE_PUBLISH);
  });

  it("revokes publication when the render changes, even after both were approved", async () => {
    const subjects = standardSubjects();
    await approve([...THROUGH_UPLOAD, RELEASE_PUBLISH], subjects);

    // A re-render after approval. §13.4 binds release approval to the final render.
    const rerendered = standardSubjects({ finalRender: "finalRender-v2" });
    const result = await engine.authorize(RUN_ID, PUBLISH_OPERATION, rerendered);
    expect(result.authorized).toBe(false);
  });

  it("refuses an operation no gate grants", async () => {
    // Adding a gate is what enables an action. Omitting one must never be what enables it.
    const subjects = standardSubjects();
    await approve([...THROUGH_UPLOAD, RELEASE_PUBLISH], subjects);

    const result = await engine.authorize(RUN_ID, "release.delete", subjects);
    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.explanation).toContain("No registered gate grants");
  });

  it("refuses an operation whose gate was rejected, not merely un-approved", async () => {
    const subjects = standardSubjects();
    await approve(THROUGH_UPLOAD, subjects);
    await engine.decide({
      runId: RUN_ID,
      gateId: RELEASE_PUBLISH,
      decision: "rejected",
      subjects: subjects[RELEASE_PUBLISH] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-publish-rejected",
      comment: "Hold until the correction runs.",
    });

    const result = await engine.authorize(RUN_ID, PUBLISH_OPERATION, subjects);
    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.explanation).toContain("rejected");
  });

  it("does not let a waived upload gate authorize publication", async () => {
    // A waiver bypasses the gate it was given on. It must not spill into the operations a
    // different gate grants.
    const subjects = standardSubjects();
    await approve([CONTENT_FREEZE, PERFORMANCE_FREEZE, HUMAN_EAR], subjects);
    await engine.decide({
      runId: RUN_ID,
      gateId: RELEASE_UPLOAD,
      decision: "waived",
      comment: "waived for this test; the engine requires a reason",
      subjects: subjects[RELEASE_UPLOAD] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-upload-waived",
    });

    // The waiver unblocks the chain, but grants nothing: `authorize` requires an approval.
    const upload = await engine.authorize(RUN_ID, UPLOAD_OPERATION, subjects);
    expect(upload.authorized).toBe(false);
    const publish = await engine.authorize(RUN_ID, PUBLISH_OPERATION, subjects);
    expect(publish.authorized).toBe(false);
  });
});
