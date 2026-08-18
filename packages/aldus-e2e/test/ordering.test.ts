/**
 * Stage ordering, driven through the composed stack (contract §11; ADR-0028, issue #55).
 *
 * The incident this reproduces, generalised from the adopter's report: a render stage regenerates
 * a caption file, and a retime stage rewrites its alignment. Run in the wrong order the retime's
 * work is silently overwritten — no error, no failed stage, just a wrong artifact that looks
 * right. Before edges, `status` would offer the retime first and `run` would perform it.
 *
 * Driven through `AldusServices` rather than the policy function, because the question is whether
 * an operator using the runtime is protected, not whether a pure function returns the right shape.
 * The per-package suite covers the second; only this covers the first.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OPERATOR, RUN_ID, SHOW_ID, makeStack, producingStage, type Stack } from "../src/index.js";

const RENDER = "render";
const RETIME = "retime";
const CHECK = "check";

/** Where both stages write, so a wrong order is observable in the bytes. */
const CAPTIONS = "captions.srt";

let stack: Stack;

afterEach(async () => {
  await stack.cleanup();
});

/**
 * A three-stage workflow: render, then retime, then check.
 *
 * `render` and `retime` both write the same file, so running them out of order leaves different
 * contents on disk — which is what makes the ordering failure detectable rather than theoretical.
 */
async function orderedStack(): Promise<Stack> {
  stack = await makeStack({
    workflow: {
      stages: [
        { stageId: RENDER, requiredGates: [] },
        { stageId: RETIME, requiredGates: [], after: [RENDER] },
        { stageId: CHECK, requiredGates: [], after: [RETIME] },
      ],
    },
    stages: (registry, workingRoot) => [
      producingStage(RENDER, {
        workingRoot,
        relativePath: CAPTIONS,
        contents: "1\n00:00:01,000 --> 00:00:02,000\nrendered\n",
        kind: "RenderedCaptions",
        mediaType: "application/x-subrip",
        reconstructability: "reproducible",
        registry,
      }),
      producingStage(RETIME, {
        workingRoot,
        relativePath: CAPTIONS,
        contents: "1\n00:00:01,500 --> 00:00:02,500\nretimed\n",
        kind: "RetimedCaptions",
        mediaType: "application/x-subrip",
        reconstructability: "source",
        registry,
      }),
      producingStage(CHECK, {
        workingRoot,
        relativePath: "check.txt",
        contents: "checked\n",
        kind: "CaptionCheck",
        mediaType: "text/plain",
        reconstructability: "reproducible",
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
  return stack;
}

describe("a stage cannot run before what it depends on", () => {
  it("refuses the retime until the render has succeeded, and nothing is written", async () => {
    await orderedStack();

    const early = await stack.services.runStage({
      runId: RUN_ID,
      stageId: RETIME,
      actor: OPERATOR,
    });

    expect(early.outcome).toBe("refused");
    if (early.outcome !== "refused") return;
    expect(early.refusal.reason).toBe("stage_predecessor_unmet");
    expect(early.refusal.explanation).toContain(RENDER);

    // The file the retime would have written must not exist: a refusal that still ran the work
    // would be no protection at all.
    await expect(readFile(join(stack.workingRoot, CAPTIONS), "utf8")).rejects.toThrow();
  });

  it("offers only the entry point, and explains why the rest are withheld", async () => {
    await orderedStack();

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") throw new Error("expected a status");
    const plan = status.data.focused?.plan;

    expect(plan?.next.map((action) => action.stageId)).toEqual([RENDER]);

    const withheld = plan?.blocked.filter((action) => action.kind === "run-stage") ?? [];
    expect(withheld.map((action) => action.stageId).sort()).toEqual([CHECK, RETIME]);
    for (const action of withheld) {
      expect(action.reason).toContain("must run after");
      expect(action.enforcement).toBe("enforced");
    }
  });

  it("runs the chain in order, leaving the retimed contents on disk", async () => {
    await orderedStack();

    for (const stageId of [RENDER, RETIME, CHECK]) {
      const result = await stack.services.runStage({ runId: RUN_ID, stageId, actor: OPERATOR });
      expect(result.outcome, `${stageId} should have run`).toBe("ok");
    }

    // The whole point of the ordering: the retime ran second, so its alignment survives.
    expect(await readFile(join(stack.workingRoot, CAPTIONS), "utf8")).toContain("retimed");
  });

  it("completes at the terminal stage without being told what the goals are", async () => {
    await orderedStack();

    for (const stageId of [RENDER, RETIME, CHECK]) {
      await stack.services.runStage({ runId: RUN_ID, stageId, actor: OPERATOR });
    }

    const status = await stack.services.status(RUN_ID);
    if (status.outcome !== "ok") throw new Error("expected a status");
    // Goals defaulted to the graph's terminal — `check` — rather than to every stage it names.
    expect(status.data.focused?.state.goalStages).toEqual([CHECK]);
    expect(status.data.focused?.state.status).toBe("completed");
  });

  it("survives a restart, because the constraint lives in the graph and not in memory", async () => {
    await orderedStack();
    await stack.services.runStage({ runId: RUN_ID, stageId: RENDER, actor: OPERATOR });

    // A fresh services instance over the same directory: the edge is re-read, not remembered.
    stack.restart();

    const blocked = await stack.services.runStage({
      runId: RUN_ID,
      stageId: CHECK,
      actor: OPERATOR,
    });
    expect(blocked.outcome, "check still waits on retime after a restart").toBe("refused");

    const allowed = await stack.services.runStage({
      runId: RUN_ID,
      stageId: RETIME,
      actor: OPERATOR,
    });
    expect(allowed.outcome, "retime is unblocked by the render that already succeeded").toBe("ok");
  });
});
