/**
 * Registration, identity, and provenance (contract §8, §8.1).
 *
 * The rules under test:
 *
 * - a path or filename MUST NOT be treated as identity;
 * - approved artifacts MUST be addressed by ID and hash;
 * - an artifact MUST record which stage, run, code revision, and configuration produced it;
 * - a provider seed MUST be recorded but MUST NOT be a reproducibility guarantee;
 * - rejected takes are retained with unique identity (§15.1).
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AldusError, validate } from "@aldus/core";

import { digestConfiguration, sha256Bytes } from "../src/digest.js";
import { ArtifactRegistryErrorCodes } from "../src/errors.js";
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

describe("register", () => {
  it("computes the digest and size from the bytes, not from the caller", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const record = await registry.register(registration(path));

    expect(record.artifact.sha256).toBe(sha256Bytes("hello"));
    expect(record.artifact.sizeBytes).toBe(5);
  });

  it("produces an ArtifactRef that satisfies Core's schema", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const record = await registry.register(registration(path));
    expect(validate("ArtifactRef", record.artifact).ok).toBe(true);
  });

  it("records the run, stage, code revision, and configuration that produced it", async () => {
    // Contract §8.1's full requirement. ArtifactRef carries run and stage; provenance carries the
    // code revision and configuration it has no field for.
    const configuration = { voice: "voice-a", sampleRate: 48_000 };
    const path = await writeWorkingFile(workspace, "working/a.wav", "audio");
    const record = await registry.register(
      registration(path, {
        producerRunId: "run-b",
        producerStageId: "stage-c",
        provenance: {
          codeRevision: "revision-a",
          configHash: digestConfiguration(configuration),
          configuration,
        },
      }),
    );

    expect(record.artifact.producerRunId).toBe("run-b");
    expect(record.artifact.producerStageId).toBe("stage-c");
    expect(record.provenance.codeRevision).toBe("revision-a");
    expect(record.provenance.configHash).toBe(digestConfiguration(configuration));
    expect(record.provenance.configuration).toEqual(configuration);
  });

  it("records a provider seed for trace", async () => {
    const path = await writeWorkingFile(workspace, "working/a.wav", "audio");
    const record = await registry.register(
      registration(path, { provenance: { providerSeed: "seed-42" } }),
    );
    expect(record.provenance.providerSeed).toBe("seed-42");
  });

  it("mints a unique ID per registration", async () => {
    const a = await writeWorkingFile(workspace, "working/a.txt", "a");
    const b = await writeWorkingFile(workspace, "working/b.txt", "b");
    const first = await registry.register(registration(a));
    const second = await registry.register(registration(b));
    expect(first.artifact.artifactId).not.toBe(second.artifact.artifactId);
  });

  it("accepts an empty inputHashes list as a real state", async () => {
    // An EpisodeBrief is derived from nothing inside the runtime; that is not a missing
    // declaration.
    const path = await writeWorkingFile(workspace, "working/brief.md", "brief");
    const record = await registry.register(registration(path));
    expect(record.artifact.inputHashes).toEqual([]);
  });
});

describe("identity (contract §8.1)", () => {
  it("survives the file being moved, because the path is not identity", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const record = await registry.register(registration(path));

    const moved = join(workspace.root, "elsewhere.txt");
    await rename(path, moved);

    // The record is unchanged and still addressable by ID and by hash.
    const stored = await registry.get(record.artifact.artifactId);
    expect(stored?.artifact.sha256).toBe(record.artifact.sha256);
    expect(await registry.findByDigest(record.artifact.sha256)).toHaveLength(1);
  });

  it("addresses an artifact by hash, returning every record that shares the content", async () => {
    const a = await writeWorkingFile(workspace, "working/a.txt", "same bytes");
    const b = await writeWorkingFile(workspace, "working/b.txt", "same bytes");
    await registry.register(registration(a));
    await registry.register(registration(b));

    const found = await registry.findByDigest(sha256Bytes("same bytes"));
    // Two artifacts that happen to share content, not one artifact — collapsing them would lose
    // the provenance that distinguishes them.
    expect(found).toHaveLength(2);
    expect(new Set(found.map((record) => record.artifact.artifactId)).size).toBe(2);
  });

  it("refuses to rebind an ID to different content", async () => {
    const a = await writeWorkingFile(workspace, "working/a.txt", "first");
    const b = await writeWorkingFile(workspace, "working/b.txt", "second");
    const record = await registry.register(registration(a, { artifactId: "art-fixed" }));

    let thrown: unknown;
    try {
      await registry.register(registration(b, { artifactId: "art-fixed" }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AldusError).code).toBe(ArtifactRegistryErrorCodes.ARTIFACT_ID_CONFLICT);

    // The original binding is intact, so approvals that referenced it still resolve.
    expect((await registry.get("art-fixed"))?.artifact.sha256).toBe(record.artifact.sha256);
  });

  it("treats re-registering identical content under the same ID as a harmless retry", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const first = await registry.register(registration(path, { artifactId: "art-fixed" }));
    const second = await registry.register(registration(path, { artifactId: "art-fixed" }));
    expect(second.artifact.sha256).toBe(first.artifact.sha256);
    expect(await registry.list()).toHaveLength(1);
  });

  it("refuses to change an artifact's ID through update", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const record = await registry.register(registration(path));

    await expect(
      registry.store.update(record.artifact.artifactId, (current) => ({
        ...current,
        artifact: { ...current.artifact, artifactId: "art-renamed" },
      })),
    ).rejects.toThrowError(AldusError);
  });
});

describe("verify", () => {
  it("passes while the bytes are unchanged", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const record = await registry.register(registration(path));
    await expect(registry.verify(record.artifact.artifactId)).resolves.toBeUndefined();
  });

  it("detects a working file that has been modified since registration", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const record = await registry.register(registration(path));
    await writeFile(path, "tampered", "utf8");

    let thrown: unknown;
    try {
      await registry.verify(record.artifact.artifactId);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AldusError).code).toBe(ArtifactRegistryErrorCodes.DIGEST_MISMATCH);
  });
});

describe("supersede (contract §15.1)", () => {
  it("records the replacement without deleting the replaced take", async () => {
    const rejected = await writeWorkingFile(workspace, "takes/req-00.wav", "rejected take");
    const accepted = await writeWorkingFile(workspace, "takes/req-01.wav", "accepted take");
    const first = await registry.register(
      registration(rejected, { reconstructability: "irreplaceable" }),
    );
    const second = await registry.register(
      registration(accepted, { reconstructability: "irreplaceable" }),
    );

    const updated = await registry.supersede(first.artifact.artifactId, second.artifact.artifactId);

    expect(updated.supersededBy).toBe(second.artifact.artifactId);
    // §15.1: retained with unique identity. A rejected paid take is evidence of what was tried.
    expect(await registry.get(first.artifact.artifactId)).toBeDefined();
    expect(await registry.list()).toHaveLength(2);
  });

  it("refuses to supersede with a replacement that is not registered", async () => {
    const path = await writeWorkingFile(workspace, "takes/req-00.wav", "take");
    const record = await registry.register(registration(path));
    await expect(
      registry.supersede(record.artifact.artifactId, "art-missing"),
    ).rejects.toThrowError(AldusError);
  });
});

describe("listByRun", () => {
  it("returns only the artifacts a Run produced", async () => {
    const a = await writeWorkingFile(workspace, "working/a.txt", "a");
    const b = await writeWorkingFile(workspace, "working/b.txt", "b");
    await registry.register(registration(a, { producerRunId: "run-a" }));
    await registry.register(registration(b, { producerRunId: "run-b" }));

    const forRunA = await registry.listByRun("run-a");
    expect(forRunA).toHaveLength(1);
    expect(forRunA[0]?.artifact.producerRunId).toBe("run-a");
  });
});

describe("persistence", () => {
  it("survives being reopened", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const record = await registry.register(registration(path));

    const reopened = makeRegistry(workspace);
    expect((await reopened.get(record.artifact.artifactId))?.artifact.sha256).toBe(
      record.artifact.sha256,
    );
  });

  it("reads an absent registry as empty rather than failing", async () => {
    const fresh = await makeTempWorkspace();
    try {
      expect(await makeRegistry(fresh).list()).toEqual([]);
    } finally {
      await fresh.cleanup();
    }
  });

  it("preserves properties written by a newer schema version (ADR-0004)", async () => {
    const path = await writeWorkingFile(workspace, "working/a.txt", "hello");
    const record = await registry.register(registration(path));

    // Simulate a newer build having added a field this build does not know about.
    const indexPath = registry.layout.indexPath();
    const raw = JSON.parse(await readTextFile(indexPath)) as {
      artifacts: Record<string, unknown>[];
    };
    const first = raw.artifacts[0];
    if (first === undefined) throw new Error("expected one artifact");
    first["futureField"] = "written by a newer build";
    await writeFile(indexPath, JSON.stringify(raw, null, 2), "utf8");

    // An older build registers a second artifact, which rewrites the whole index.
    const second = await writeWorkingFile(workspace, "working/b.txt", "world");
    await registry.register(registration(second));

    const after = JSON.parse(await readTextFile(indexPath)) as {
      artifacts: Record<string, unknown>[];
    };
    const preserved = after.artifacts.find(
      (entry) =>
        (entry["artifact"] as { artifactId?: string } | undefined)?.artifactId ===
        record.artifact.artifactId,
    );
    expect(preserved?.["futureField"]).toBe("written by a newer build");
  });

  it("reports a malformed index rather than treating it as empty", async () => {
    await mkdir(registry.layout.artifactsDirectory(), { recursive: true });
    await writeFile(registry.layout.indexPath(), "{ not json", "utf8");
    let thrown: unknown;
    try {
      await registry.list();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AldusError).code).toBe(ArtifactRegistryErrorCodes.REGISTRY_MALFORMED);
  });

  it("withholds index contents from the malformed-index error (contract §19.2)", async () => {
    await mkdir(registry.layout.artifactsDirectory(), { recursive: true });
    await writeFile(registry.layout.indexPath(), '{ "secret": "tok_live_do_not_leak"', "utf8");
    let thrown: unknown;
    try {
      await registry.list();
    } catch (error) {
      thrown = error;
    }
    // An error is durable. Echoing the file into it would leak whatever the file held.
    expect(JSON.stringify((thrown as AldusError).toStructuredError())).not.toContain(
      "tok_live_do_not_leak",
    );
  });
});

async function readTextFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
