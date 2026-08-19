/**
 * Registering an artifact through the stage context (#39, #67).
 *
 * Every other stage in this package closes over a registry — the form `StageFactory` exists to
 * make possible. That is precisely why #67 survived: `context.registerOutput` refused for every
 * stage the services ran, because `AldusContext.runnerFor` never passed the port, and nothing
 * here exercised the new API. The unit tests for each layer passed, because each layer was
 * correct on its own.
 *
 * A capability nothing exercises is a capability nobody notices is unwired.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeStack, selfRegisteringStage, type Stack } from "../src/index.js";

const SHOW_ID = "example-show";
const RUN_ID = "run-registration";
const OPERATOR = { kind: "human", id: "operator-a" } as const;

let stack: Stack;

beforeEach(async () => {
  stack = await makeStack({
    stages: (_registry, workingRoot) => [
      selfRegisteringStage("render", {
        workingRoot,
        relativePath: "render/out.bin",
        contents: "bytes the stage produced",
        kind: "RenderedVideo",
        mediaType: "application/octet-stream",
        reconstructability: "reproducible",
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
});

afterEach(async () => {
  await stack.cleanup();
});

describe("registerOutput through the composed stack", () => {
  it("registers, and the runner supplies the provenance the stage never named", async () => {
    const run = await stack.services.runStage({
      runId: RUN_ID,
      stageId: "render",
      actor: OPERATOR,
    });
    expect(run.outcome, "registerOutput must not refuse through the services").toBe("ok");

    const report = await stack.services.artifacts(RUN_ID);
    expect(report.outcome).toBe("ok");
    if (report.outcome !== "ok") return;

    const artifact = report.data.artifacts[0];
    expect(artifact).toBeDefined();

    // The fields a stage cannot state, filled from the attempt that produced the file.
    expect(artifact?.producerRunId).toBe(RUN_ID);
    expect(artifact?.producerStageId).toBe("render");
    expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Registered, not merely recorded — `unregistered` is what surfaces the difference.
    expect(report.data.unregistered).toEqual([]);
  });

  it("computes the digest itself rather than trusting the stage", async () => {
    await stack.services.runStage({ runId: RUN_ID, stageId: "render", actor: OPERATOR });
    const report = await stack.services.artifacts(RUN_ID);
    if (report.outcome !== "ok") throw new Error("expected artifacts");
    const artifact = report.data.artifacts[0];
    if (artifact === undefined) throw new Error("expected an artifact");

    // §8.1: identity is the digest, and the registry computes it — the registration type has no
    // field for a caller-supplied sha256, so a stage cannot assert one that disagrees with the
    // bytes. `uri` still points at the working file; archival is a separate, explicit act.
    const bytes = await readFile(new URL(artifact.uri), "utf8");
    expect(bytes).toBe("bytes the stage produced");
    expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
