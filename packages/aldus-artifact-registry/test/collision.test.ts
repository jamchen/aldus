/**
 * The `req-00.wav` failure.
 *
 * Contract §8.1 names one concrete data-loss failure the registry exists to prevent:
 *
 * > Generic names such as `req-00.wav` MUST NOT overwrite accepted audio from another Episode.
 *
 * Contract §1.1 lists "loss or overwrite of accepted audio takes" among the things V1 must
 * reduce. This file reproduces the failure as it happens without a registry, then proves each of
 * the mechanisms that make it impossible with one.
 *
 * This is the most important test in the package. If it is ever weakened, the package has lost
 * the reason it was written.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalDirectoryArchive } from "../src/archive.js";
import { planCleanup } from "../src/cleanup.js";
import { ArtifactRegistryErrorCodes } from "../src/errors.js";
import { objectRelativePath, readableFileName } from "../src/paths.js";
import { ArtifactRegistry } from "../src/registry.js";
import {
  makeRegistry,
  makeTempWorkspace,
  registration,
  writeWorkingFile,
  type TempWorkspace,
} from "./helpers.js";

let workspace: TempWorkspace;
let registry: ArtifactRegistry;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
  registry = makeRegistry(workspace);
});

afterEach(async () => {
  await workspace.cleanup();
});

/** Two Episodes, each producing a file with the same generic name and different audio. */
const EPISODE_A_AUDIO = "audio bytes for episode a: approved take";
const EPISODE_B_AUDIO = "audio bytes for episode b: a completely different recording";

describe("the failure this package prevents", () => {
  it("reproduces the overwrite that happens without content addressing", async () => {
    // The original failure, stated plainly: two Episodes, one shared output directory, one
    // generic filename. The second write destroys the first, and nothing reports it.
    const shared = join(workspace.root, "working", "req-00.wav");
    await writeWorkingFile(workspace, "working/req-00.wav", EPISODE_A_AUDIO);
    await writeFile(shared, EPISODE_B_AUDIO, "utf8");

    expect(await readFile(shared, "utf8")).toBe(EPISODE_B_AUDIO);
    // Episode A's approved take is gone, and no re-run brings it back.
  });

  it("keeps both takes when each Episode registers its own req-00.wav", async () => {
    const pathA = await writeWorkingFile(workspace, "episode-a/req-00.wav", EPISODE_A_AUDIO);
    const pathB = await writeWorkingFile(workspace, "episode-b/req-00.wav", EPISODE_B_AUDIO);

    const a = await registry.register(
      registration(pathA, {
        kind: "ApprovedAudio",
        mediaType: "audio/wav",
        producerRunId: "run-a",
        reconstructability: "irreplaceable",
      }),
    );
    const b = await registry.register(
      registration(pathB, {
        kind: "ApprovedAudio",
        mediaType: "audio/wav",
        producerRunId: "run-b",
        reconstructability: "irreplaceable",
      }),
    );

    // Distinct identities, despite identical filenames.
    expect(a.artifact.artifactId).not.toBe(b.artifact.artifactId);
    expect(a.artifact.sha256).not.toBe(b.artifact.sha256);

    // Both retained and independently addressable, by ID and by hash (§8.1).
    expect((await registry.get(a.artifact.artifactId))?.artifact.sha256).toBe(a.artifact.sha256);
    expect((await registry.get(b.artifact.artifactId))?.artifact.sha256).toBe(b.artifact.sha256);
    expect(await registry.findByDigest(a.artifact.sha256)).toHaveLength(1);
    expect(await registry.findByDigest(b.artifact.sha256)).toHaveLength(1);
    expect(await registry.list()).toHaveLength(2);
  });

  it("archives both takes to different locations even though both are named req-00.wav", async () => {
    const pathA = await writeWorkingFile(workspace, "episode-a/req-00.wav", EPISODE_A_AUDIO);
    const pathB = await writeWorkingFile(workspace, "episode-b/req-00.wav", EPISODE_B_AUDIO);

    const a = await registry.register(
      registration(pathA, { reconstructability: "irreplaceable", producerRunId: "run-a" }),
    );
    const b = await registry.register(
      registration(pathB, { reconstructability: "irreplaceable", producerRunId: "run-b" }),
    );

    const archivedA = await registry.archiveArtifact(a.artifact.artifactId);
    const archivedB = await registry.archiveArtifact(b.artifact.artifactId);

    expect(archivedA.archive?.uri).not.toBe(archivedB.archive?.uri);

    // Both sets of bytes survive, and each is retrievable under its own digest.
    const bytesA = await registry.archive.read(a.artifact.sha256);
    const bytesB = await registry.archive.read(b.artifact.sha256);
    expect(Buffer.from(bytesA).toString("utf8")).toBe(EPISODE_A_AUDIO);
    expect(Buffer.from(bytesB).toString("utf8")).toBe(EPISODE_B_AUDIO);
  });

  it("derives the archive path from content, so the filename cannot participate", () => {
    // The structural guarantee. Nothing the producer named the file appears in its object path,
    // so two files cannot collide unless their bytes are identical.
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    expect(objectRelativePath(digestA)).not.toContain("req-00");
    expect(objectRelativePath(digestA)).not.toBe(objectRelativePath(digestB));
  });

  it("deduplicates identical bytes rather than storing them twice", async () => {
    // The one case where sharing storage is correct: the same bytes are the same artifact
    // content, whatever two producers called the file.
    const pathA = await writeWorkingFile(workspace, "episode-a/req-00.wav", EPISODE_A_AUDIO);
    const pathB = await writeWorkingFile(workspace, "episode-b/take-07.wav", EPISODE_A_AUDIO);

    const a = await registry.register(registration(pathA, { reconstructability: "irreplaceable" }));
    const b = await registry.register(registration(pathB, { reconstructability: "irreplaceable" }));

    expect(a.artifact.sha256).toBe(b.artifact.sha256);
    // Two artifacts, two provenances, one stored object — and both records survive.
    expect(a.artifact.artifactId).not.toBe(b.artifact.artifactId);
    expect(await registry.findByDigest(a.artifact.sha256)).toHaveLength(2);

    await registry.archiveArtifact(a.artifact.artifactId);
    await registry.archiveArtifact(b.artifact.artifactId);
    const archive = registry.archive as LocalDirectoryArchive;
    expect(await archive.locate(a.artifact.sha256)).toBe(await archive.locate(b.artifact.sha256));
  });

  it("refuses to execute a plan whose cleared path was rewritten after planning", async () => {
    // The same failure arriving through cleanup instead of registration.
    //
    // Registration defends `req-00.wav` by identity: two takes, two artifactIds, both retained.
    // A cleanup plan then reintroduces the loss by carrying a *path*. The plan clears take A —
    // correctly, it is archived — and by the time it executes, the operator has re-recorded into
    // the same generic name and registered take B, which is irreplaceable and unarchived.
    //
    // Deleting on the strength of the older plan discards bytes nothing ever examined, and for
    // `irreplaceable` no re-run brings them back. `plan.safe` is true throughout and was never
    // wrong about take A, which is what makes this hard to see.
    const pathA = await writeWorkingFile(workspace, "takes/req-00.wav", EPISODE_A_AUDIO);
    const a = await registry.register(
      registration(pathA, { reconstructability: "irreplaceable", producerRunId: "run-a" }),
    );
    await registry.archiveArtifact(a.artifact.artifactId);

    const plan = planCleanup([a.artifact.artifactId], await registry.list());
    expect(plan.safe).toBe(true);

    // The re-take, at the same generic path.
    const pathB = await writeWorkingFile(workspace, "takes/req-00.wav", EPISODE_B_AUDIO);
    const b = await registry.register(
      registration(pathB, { reconstructability: "irreplaceable", producerRunId: "run-b" }),
    );

    await expect(registry.executeCleanup(plan)).rejects.toMatchObject({
      code: ArtifactRegistryErrorCodes.CLEANUP_STALE_PLAN,
    });

    // The bytes are still there, and still take B's.
    expect(await readFile(pathB, "utf8")).toBe(EPISODE_B_AUDIO);
    expect((await registry.get(b.artifact.artifactId))?.artifact.sha256).toBe(b.artifact.sha256);
  });

  it("removes nothing at all when any one file in the plan is stale", async () => {
    // Refusing per-file would leave a half-executed plan behind, and the operator would have to
    // work out which half. The whole pass is checked before anything is unlinked.
    const pathA = await writeWorkingFile(workspace, "takes/a.wav", EPISODE_A_AUDIO);
    const pathB = await writeWorkingFile(workspace, "takes/b.wav", EPISODE_B_AUDIO);
    const a = await registry.register(
      registration(pathA, { reconstructability: "reproducible", producerRunId: "run-a" }),
    );
    const b = await registry.register(
      registration(pathB, { reconstructability: "reproducible", producerRunId: "run-b" }),
    );
    const plan = planCleanup([a.artifact.artifactId, b.artifact.artifactId], await registry.list());
    expect(plan.safe).toBe(true);

    await writeWorkingFile(workspace, "takes/b.wav", "rewritten after planning");

    await expect(registry.executeCleanup(plan)).rejects.toMatchObject({
      code: ArtifactRegistryErrorCodes.CLEANUP_STALE_PLAN,
    });
    // The untouched file survives too: one stale entry voids the plan, it does not filter it.
    expect(await readFile(pathA, "utf8")).toBe(EPISODE_A_AUDIO);
  });

  it("still cleans a plan whose files are unchanged", async () => {
    // The guard must not make ordinary cleanup impossible.
    const path = await writeWorkingFile(workspace, "takes/c.wav", EPISODE_A_AUDIO);
    const record = await registry.register(
      registration(path, { reconstructability: "reproducible", producerRunId: "run-c" }),
    );
    const plan = planCleanup([record.artifact.artifactId], await registry.list());

    const outcome = await registry.executeCleanup(plan);
    expect(outcome.removed).toHaveLength(1);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("gives a human-readable export name that still cannot collide", () => {
    const nameA = readableFileName("a".repeat(64), "req-00.wav");
    const nameB = readableFileName("b".repeat(64), "req-00.wav");
    expect(nameA).not.toBe(nameB);
    // Still recognisable to the person who has to listen to it.
    expect(nameA.endsWith("req-00.wav")).toBe(true);
  });
});
