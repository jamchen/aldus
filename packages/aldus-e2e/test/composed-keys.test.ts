/**
 * The invocation fingerprint and the effect key, through the composed stack (#113).
 *
 * The runner-level tests build a `StageRunner` and read its metadata. This one goes through
 * `AldusServices` over a real workspace, because the measured defect was about a stage that
 * resolves its work from the Run — and "the Run" is a thing only the composition supplies.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeStack, type Stack } from "../src/index.js";

const RUN_ID = "run-keys";
const OPERATOR = { kind: "human", id: "operator-a" } as const;

const anySchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };

let stack: Stack;

afterEach(async () => {
  await stack?.cleanup();
});

/** A stage that declares no input at all — the shape whose key was a global constant. */
function resolvesFromTheRun(id: string) {
  return {
    id,
    version: "1",
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" as const },
    execute: () => Promise.resolve({ kind: "completed" as const, output: undefined }),
  };
}

/** Run one stage in a fresh workspace for the named show and slug, and return its keys. */
async function keysFor(showId: string, slug: string) {
  stack = await makeStack({ stages: () => [resolvesFromTheRun("caption.check") as never] });
  await stack.services.init({ episode: { showId, slug }, actor: OPERATOR });
  await stack.services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: RUN_ID,
    actor: OPERATOR,
  });
  await stack.services.runStage({ runId: RUN_ID, stageId: "caption.check", actor: OPERATOR });

  // Read the durable attempt record rather than a report, because the invocation key is metadata
  // the trace carries and not something `status` renders. Parsed rather than pattern-matched: the
  // first 64-hex string in that file is `configurationHash`, which is the digest of an empty
  // configuration and therefore identical across episodes — a regex here passes by finding the
  // wrong field.
  const raw = await readFile(join(stack.root, ".aldus", "runs", RUN_ID, "stages.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    stages: { metadata: Record<string, { invocationKey?: string }> }[];
  };
  const metadata = Object.values(parsed.stages[0]?.metadata ?? {})[0];
  const cleanup = stack.cleanup;
  return { invocationKey: metadata?.invocationKey, cleanup };
}

describe("a stage that resolves its work from the Run (#113)", () => {
  it("gets a different invocation key per episode, through the composition", async () => {
    // The measured defect: with the old material this key was a constant per stage, identical
    // across every run of every episode. Two episodes here, composed rather than constructed.
    const first = await keysFor("example-show", "episode-one");
    const firstKey = first.invocationKey;
    await first.cleanup();

    const second = await keysFor("example-show", "episode-two");
    const secondKey = second.invocationKey;

    expect(firstKey).toBeTypeOf("string");
    expect(firstKey).not.toBe(secondKey);
  });
});
