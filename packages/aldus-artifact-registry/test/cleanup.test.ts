/**
 * Reconstructability policy (contract §8.1).
 *
 * > Irreplaceable artifacts MUST be archived before disposable working files are cleaned.
 *
 * The ordering is the rule. These tests pin the refusal that enforces it, and — equally — pin
 * that the refusal does not over-reach into artifacts that can be regenerated, because a policy
 * that blocks everything gets bypassed.
 */

import { access } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoreErrorCodes, AldusError } from "@aldus/core";

import { ArtifactRegistryErrorCodes } from "../src/errors.js";
import { isArchived, planCleanup, requiresArchiveBeforeCleanup } from "../src/cleanup.js";
import { ArtifactRegistry } from "../src/registry.js";
import type { ArtifactRecord } from "../src/record.js";
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function registerAt(
  relativePath: string,
  contents: string,
  reconstructability: ArtifactRecord["artifact"]["reconstructability"],
): Promise<{ record: ArtifactRecord; path: string }> {
  const path = await writeWorkingFile(workspace, relativePath, contents);
  const record = await registry.register(registration(path, { reconstructability }));
  return { record, path };
}

describe("requiresArchiveBeforeCleanup", () => {
  it("requires archival only for irreplaceable artifacts", () => {
    expect(requiresArchiveBeforeCleanup("irreplaceable")).toBe(true);
    expect(requiresArchiveBeforeCleanup("reproducible")).toBe(false);
    expect(requiresArchiveBeforeCleanup("source")).toBe(false);
  });
});

describe("planCleanup", () => {
  it("blocks an unarchived irreplaceable artifact", async () => {
    const { record } = await registerAt("takes/req-00.wav", "paid take", "irreplaceable");
    const plan = await registry.planCleanup([record.artifact.artifactId]);

    expect(plan.safe).toBe(false);
    expect(plan.removable).toHaveLength(0);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]?.reason).toBe("unarchived-irreplaceable");
  });

  it("clears the same artifact once it is archived", async () => {
    const { record } = await registerAt("takes/req-00.wav", "paid take", "irreplaceable");
    await registry.archiveArtifact(record.artifact.artifactId);

    const plan = await registry.planCleanup([record.artifact.artifactId]);
    expect(plan.safe).toBe(true);
    expect(plan.removable.map((entry) => entry.artifact.artifactId)).toEqual([
      record.artifact.artifactId,
    ]);
  });

  it("clears reproducible and source artifacts without archival", async () => {
    const reproducible = await registerAt("working/render.mp4", "render", "reproducible");
    const source = await registerAt("working/brief.md", "brief", "source");

    const plan = await registry.planCleanup([
      reproducible.record.artifact.artifactId,
      source.record.artifact.artifactId,
    ]);
    expect(plan.safe).toBe(true);
    expect(plan.removable).toHaveLength(2);
  });

  it("blocks an irreplaceable artifact whose receipt is unverified", () => {
    // A receipt that says the archive could not confirm custody is a belief, not custody. Built
    // directly rather than through the local archive, which always verifies.
    const record: ArtifactRecord = {
      schemaVersion: "1.2",
      artifact: {
        schemaVersion: "1.2",
        artifactId: "art-a",
        kind: "kind-a",
        uri: "file:///tmp/example",
        sha256: "a".repeat(64),
        mediaType: "audio/wav",
        producerRunId: "run-a",
        producerStageId: "stage-a",
        inputHashes: [],
        reconstructability: "irreplaceable",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      provenance: {},
      archive: {
        archiveId: "archive-a",
        uri: "archive:///a",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        archivedAt: "2026-01-01T00:00:00.000Z",
        verified: false,
      },
      registeredAt: "2026-01-01T00:00:00.000Z",
    };

    const plan = planCleanup(["art-a"], [record]);
    expect(plan.safe).toBe(false);
    expect(plan.blocked[0]?.reason).toBe("archive-unverified");
    expect(isArchived(record)).toBe(false);
  });

  it("reports candidates that are not registered rather than silently ignoring them", async () => {
    const plan = await registry.planCleanup(["art-does-not-exist"]);
    expect(plan.unknownArtifactIds).toEqual(["art-does-not-exist"]);
    expect(plan.safe).toBe(true);
  });

  it("never widens the caller's request", async () => {
    const asked = await registerAt("working/a.txt", "a", "reproducible");
    await registerAt("working/b.txt", "b", "reproducible");

    const plan = await registry.planCleanup([asked.record.artifact.artifactId]);
    expect(plan.removable).toHaveLength(1);
  });

  it("does not treat a recorded provider seed as making an artifact reproducible", async () => {
    // Contract §8.1: a seed MUST be recorded but MUST NOT be treated as a reproducibility
    // guarantee. §1.2 states outright that a seed is not guaranteed to reproduce identical audio.
    const path = await writeWorkingFile(workspace, "takes/seeded.wav", "seeded take");
    const record = await registry.register(
      registration(path, {
        reconstructability: "irreplaceable",
        provenance: { providerSeed: "seed-12345" },
      }),
    );

    expect(record.provenance.providerSeed).toBe("seed-12345");
    const plan = await registry.planCleanup([record.artifact.artifactId]);
    expect(plan.safe).toBe(false);
  });
});

describe("executeCleanup", () => {
  it("refuses the whole plan rather than skipping the blocked entries", async () => {
    const safe = await registerAt("working/render.mp4", "render", "reproducible");
    const unsafe = await registerAt("takes/req-00.wav", "paid take", "irreplaceable");

    const plan = await registry.planCleanup([
      safe.record.artifact.artifactId,
      unsafe.record.artifact.artifactId,
    ]);

    let thrown: unknown;
    try {
      await registry.executeCleanup(plan);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AldusError);
    expect((thrown as AldusError).code).toBe(ArtifactRegistryErrorCodes.CLEANUP_BLOCKED);
    expect((thrown as AldusError).category).toBe("policy");

    // Nothing was removed — not even the artifact that was individually safe. A partial cleanup
    // that reported failure would leave the operator unsure what state the workspace is in.
    expect(await exists(safe.path)).toBe(true);
    expect(await exists(unsafe.path)).toBe(true);
  });

  it("removes working files once the plan is clear", async () => {
    const { record, path } = await registerAt("takes/req-00.wav", "paid take", "irreplaceable");
    await registry.archiveArtifact(record.artifact.artifactId);

    const plan = await registry.planCleanup([record.artifact.artifactId]);
    const outcome = await registry.executeCleanup(plan);

    expect(outcome.removed).toHaveLength(1);
    expect(await exists(path)).toBe(false);
  });

  it("keeps the registry record after the working file is gone", async () => {
    // §8.1: identity is the record, not the file. Cleaning a working file must not erase the
    // artifact's existence, or every approval that referenced it becomes undecipherable.
    const { record } = await registerAt("takes/req-00.wav", "paid take", "irreplaceable");
    await registry.archiveArtifact(record.artifact.artifactId);
    await registry.executeCleanup(await registry.planCleanup([record.artifact.artifactId]));

    const stored = await registry.get(record.artifact.artifactId);
    expect(stored?.artifact.sha256).toBe(record.artifact.sha256);
    expect(stored?.archive?.verified).toBe(true);
  });

  it("recovers the archived bytes after the working file is cleaned", async () => {
    // The end-to-end proof that the ordering rule is worth something: after cleanup, the only
    // surviving copy is the archived one, and it is still the right bytes.
    const { record, path } = await registerAt(
      "takes/req-00.wav",
      "the approved take",
      "irreplaceable",
    );
    await registry.archiveArtifact(record.artifact.artifactId);
    await registry.executeCleanup(await registry.planCleanup([record.artifact.artifactId]));

    expect(await exists(path)).toBe(false);
    const bytes = await registry.archive.read(record.artifact.sha256);
    expect(Buffer.from(bytes).toString("utf8")).toBe("the approved take");
  });

  it("tolerates a working file that is already gone", async () => {
    const { record, path } = await registerAt("working/render.mp4", "render", "reproducible");
    const plan = await registry.planCleanup([record.artifact.artifactId]);
    await registry.executeCleanup(plan);
    expect(await exists(path)).toBe(false);

    const outcome = await registry.executeCleanup(plan);
    expect(outcome.removed).toHaveLength(0);
    expect(outcome.alreadyAbsent).toHaveLength(1);
  });
});

describe("archiveIrreplaceable", () => {
  it("archives exactly the irreplaceable artifacts that are not yet archived", async () => {
    const a = await registerAt("takes/a.wav", "take a", "irreplaceable");
    const b = await registerAt("takes/b.wav", "take b", "irreplaceable");
    await registerAt("working/render.mp4", "render", "reproducible");
    await registry.archiveArtifact(a.record.artifact.artifactId);

    const archived = await registry.archiveIrreplaceable();
    expect(archived.map((record) => record.artifact.artifactId)).toEqual([
      b.record.artifact.artifactId,
    ]);

    const all = await registry.list();
    const irreplaceable = all.filter(
      (record) => record.artifact.reconstructability === "irreplaceable",
    );
    expect(irreplaceable.every(isArchived)).toBe(true);
    // The reproducible one is left alone: archiving it would cost storage for bytes a re-run
    // regenerates.
    expect(
      all.find((record) => record.artifact.reconstructability === "reproducible")?.archive,
    ).toBeUndefined();
  });
});

describe("error codes", () => {
  it("does not collide with Core's codes", () => {
    const core = new Set<string>(Object.values(CoreErrorCodes));
    for (const code of Object.values(ArtifactRegistryErrorCodes)) {
      expect(core.has(code), `${code} collides with a Core error code`).toBe(false);
      expect(code).toMatch(/^ALDUS_[A-Z0-9_]+$/);
    }
  });
});
