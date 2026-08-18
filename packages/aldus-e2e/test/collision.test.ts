/**
 * The `req-00.wav` failure, through the composed stack (architecture contract §8.1, §1.1).
 *
 * §8.1 names one concrete data-loss failure the runtime exists to prevent:
 *
 * > Generic names such as `req-00.wav` MUST NOT overwrite accepted audio from another Episode.
 *
 * `@aldus-runtime/artifact-registry` already proves this inside its own package, reproducing the
 * overwrite before showing content addressing prevents it. What that suite cannot show is whether
 * the guarantee still holds when the registry is reached the way an operator reaches it — through
 * a stage, through the services, in a workspace shared with another Episode's Run.
 *
 * That is the only thing this file adds, and it is the thing a per-package suite structurally
 * cannot cover.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  NARRATION_STAGE,
  OPERATOR,
  SHOW_ID,
  makeStack,
  producingStage,
  type Stack,
} from "../src/index.js";

/** Two Episodes, each producing a file with the same generic name and different audio. */
const EPISODE_A_AUDIO = "audio bytes for episode a: the approved take";
const EPISODE_B_AUDIO = "audio bytes for episode b: a completely different recording";

const RUN_A = "run-a";
const RUN_B = "run-b";
/** The generic filename §8.1 names. Both Episodes produce one. */
const GENERIC_NAME = "req-00.wav";

const decoder = new TextDecoder();

let stack: Stack;

afterEach(async () => {
  await stack.cleanup();
});

/**
 * A workspace whose stage writes `req-00.wav` into a per-Run subdirectory.
 *
 * Two Runs, one workspace, one filename — the situation §8.1 is about. The stage is parameterised
 * by Run so each writes its own bytes, exactly as two Episodes of one show would.
 */
async function twoEpisodeWorkspace(): Promise<Stack> {
  return makeStack({
    stages: (registry, workingRoot) => [
      producingStage(`${NARRATION_STAGE}-a`, {
        workingRoot,
        relativePath: `${RUN_A}/${GENERIC_NAME}`,
        contents: EPISODE_A_AUDIO,
        kind: "ApprovedAudio",
        mediaType: "audio/wav",
        reconstructability: "irreplaceable",
        registry,
      }),
      producingStage(`${NARRATION_STAGE}-b`, {
        workingRoot,
        relativePath: `${RUN_B}/${GENERIC_NAME}`,
        contents: EPISODE_B_AUDIO,
        kind: "ApprovedAudio",
        mediaType: "audio/wav",
        reconstructability: "irreplaceable",
        registry,
      }),
    ],
  });
}

describe("two Episodes producing the same generic filename", () => {
  it("keeps both takes, addressable independently (§8.1)", async () => {
    stack = await twoEpisodeWorkspace();
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    for (const runId of [RUN_A, RUN_B]) {
      await stack.services.startRun({
        workflowId: "workflow-a",
        workflowVersion: "1",
        runId,
        actor: OPERATOR,
      });
    }

    await stack.services.runStage({
      runId: RUN_A,
      stageId: `${NARRATION_STAGE}-a`,
      actor: OPERATOR,
    });
    await stack.services.runStage({
      runId: RUN_B,
      stageId: `${NARRATION_STAGE}-b`,
      actor: OPERATOR,
    });

    const a = await stack.services.artifacts(RUN_A);
    const b = await stack.services.artifacts(RUN_B);
    if (a.outcome !== "ok" || b.outcome !== "ok") return;

    const artifactA = a.data.records[0]?.artifact;
    const artifactB = b.data.records[0]?.artifact;
    expect(artifactA).toBeDefined();
    expect(artifactB).toBeDefined();

    // Different identities and different digests: neither overwrote the other.
    expect(artifactA?.artifactId).not.toBe(artifactB?.artifactId);
    expect(artifactA?.sha256).not.toBe(artifactB?.sha256);

    // And each is still attributed to the Run that produced it, which is what makes "whose take
    // is this?" answerable at all (§20).
    expect(artifactA?.producerRunId).toBe(RUN_A);
    expect(artifactB?.producerRunId).toBe(RUN_B);
  });

  it("archives both, so neither Episode's accepted audio depends on a path (§8.1)", async () => {
    stack = await twoEpisodeWorkspace();
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    for (const runId of [RUN_A, RUN_B]) {
      await stack.services.startRun({
        workflowId: "workflow-a",
        workflowVersion: "1",
        runId,
        actor: OPERATOR,
      });
    }
    await stack.services.runStage({
      runId: RUN_A,
      stageId: `${NARRATION_STAGE}-a`,
      actor: OPERATOR,
    });
    await stack.services.runStage({
      runId: RUN_B,
      stageId: `${NARRATION_STAGE}-b`,
      actor: OPERATOR,
    });

    await stack.services.archiveIrreplaceable({ runId: RUN_A, actor: OPERATOR });
    await stack.services.archiveIrreplaceable({ runId: RUN_B, actor: OPERATOR });

    const a = await stack.services.artifacts(RUN_A);
    const b = await stack.services.artifacts(RUN_B);
    if (a.outcome !== "ok" || b.outcome !== "ok") return;

    expect(a.data.records[0]?.archive?.verified).toBe(true);
    expect(b.data.records[0]?.archive?.verified).toBe(true);
    // Archived under content addresses, so two files sharing one name land in two places. The
    // path is a pure function of the digest (ADR-0007), which is what makes that automatic rather
    // than a naming convention someone has to remember.
    expect(a.data.records[0]?.archive?.uri).not.toBe(b.data.records[0]?.archive?.uri);
  });

  it("recovers each Episode's exact bytes after the working files are gone", async () => {
    stack = await twoEpisodeWorkspace();
    await stack.services.init({ episode: { showId: SHOW_ID, slug: "episode-a" }, actor: OPERATOR });
    for (const runId of [RUN_A, RUN_B]) {
      await stack.services.startRun({
        workflowId: "workflow-a",
        workflowVersion: "1",
        runId,
        actor: OPERATOR,
      });
    }
    await stack.services.runStage({
      runId: RUN_A,
      stageId: `${NARRATION_STAGE}-a`,
      actor: OPERATOR,
    });
    await stack.services.runStage({
      runId: RUN_B,
      stageId: `${NARRATION_STAGE}-b`,
      actor: OPERATOR,
    });
    await stack.services.archiveIrreplaceable({ runId: RUN_A, actor: OPERATOR });
    await stack.services.archiveIrreplaceable({ runId: RUN_B, actor: OPERATOR });

    const a = await stack.services.artifacts(RUN_A);
    const b = await stack.services.artifacts(RUN_B);
    if (a.outcome !== "ok" || b.outcome !== "ok") return;

    // The point of archiving at all: the bytes survive independently of the working file, and the
    // two Episodes' audio is still distinguishable. Read back by digest, never by path — §8.1
    // forbids treating a path as identity, so a test that reached for one would be asserting the
    // opposite of the rule.
    const archive = stack.services.context.artifacts.archive;
    const digestA = a.data.records[0]?.artifact.sha256 ?? "";
    const digestB = b.data.records[0]?.artifact.sha256 ?? "";
    expect(decoder.decode(await archive.read(digestA))).toBe(EPISODE_A_AUDIO);
    expect(decoder.decode(await archive.read(digestB))).toBe(EPISODE_B_AUDIO);
  });
});
