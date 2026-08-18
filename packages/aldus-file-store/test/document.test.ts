/**
 * Forward-compatible round-tripping (ADR-0004 decision 3).
 *
 * Zod strips unknown properties, so a naive read-modify-write silently deletes fields written by
 * a newer minor version. These tests pin the merge rules that prevent it — and, just as
 * important, pin the case where preservation must NOT happen, because resurrecting a field a
 * caller deliberately deleted is its own kind of data corruption.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AldusError, SCHEMA_VERSION } from "@aldus/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeForWrite, preserveUnknown, readDocument, writeDocument } from "../src/document.js";
import { FileStoreErrorCodes } from "../src/errors.js";

import { anEpisode, makeTempWorkspace, type TempWorkspace } from "./helpers.js";

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

describe("preserveUnknown", () => {
  it("keeps a property the current build does not know about", () => {
    const raw = { a: 1, futureField: "keep me" };
    const original = { a: 1 };
    const next = { a: 2 };
    expect(preserveUnknown(raw, original, next)).toEqual({ a: 2, futureField: "keep me" });
  });

  // The counterpart, and the reason the merge takes three arguments rather than two: a key the
  // build knows about and the caller removed must stay removed.
  it("drops a known property the caller deliberately deleted", () => {
    const raw = { a: 1, title: "old" };
    const original = { a: 1, title: "old" };
    const next = { a: 1 };
    expect(preserveUnknown(raw, original, next)).toEqual({ a: 1 });
  });

  it("preserves unknown properties nested inside a known object", () => {
    const raw = { episode: { id: "e", futureNested: true } };
    const original = { episode: { id: "e" } };
    const next = { episode: { id: "e2" } };
    expect(preserveUnknown(raw, original, next)).toEqual({
      episode: { id: "e2", futureNested: true },
    });
  });

  it("preserves unknown properties inside array elements when the length is unchanged", () => {
    const raw = { packs: [{ id: "p", futureField: 1 }] };
    const original = { packs: [{ id: "p" }] };
    const next = { packs: [{ id: "p2" }] };
    expect(preserveUnknown(raw, original, next)).toEqual({ packs: [{ id: "p2", futureField: 1 }] });
  });

  it("takes the new array wholesale when the length changed", () => {
    // Index identity no longer holds, and attaching a field to the wrong element would be worse
    // than dropping it.
    const raw = { packs: [{ id: "p", futureField: 1 }] };
    const original = { packs: [{ id: "p" }] };
    const next = { packs: [{ id: "p" }, { id: "q" }] };
    expect(preserveUnknown(raw, original, next)).toEqual({ packs: [{ id: "p" }, { id: "q" }] });
  });

  it("returns the new value when the shapes are not both objects", () => {
    expect(preserveUnknown({ a: 1 }, { a: 1 }, "scalar")).toBe("scalar");
    expect(preserveUnknown(null, null, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("readDocument", () => {
  it("returns undefined for a record that has never been written", async () => {
    expect(await readDocument(join(workspace.root, "episode.json"), "EpisodeRef")).toBeUndefined();
  });

  it("round-trips a valid record", async () => {
    const path = join(workspace.root, "episode.json");
    const episode = anEpisode();
    await writeDocument(path, episode);

    const document = await readDocument(path, "EpisodeRef");
    expect(document?.value).toEqual(episode);
    expect(document?.compatibility).toBe("compatible");
  });

  it("rejects bytes that are not JSON", async () => {
    const path = join(workspace.root, "episode.json");
    await writeFile(path, "{not json", "utf8");
    try {
      await readDocument(path, "EpisodeRef");
      expect.unreachable("expected a malformed-record error");
    } catch (error) {
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.RECORD_MALFORMED);
    }
  });

  it("rejects JSON that is not an object", async () => {
    const path = join(workspace.root, "episode.json");
    await writeFile(path, "[1,2,3]", "utf8");
    await expect(readDocument(path, "EpisodeRef")).rejects.toThrow(AldusError);
  });

  it("never puts the file's contents into the error", async () => {
    const path = join(workspace.root, "episode.json");
    await writeFile(path, '{"token":"SHOULD-NOT-APPEAR", ', "utf8");
    try {
      await readDocument(path, "EpisodeRef");
      expect.unreachable("expected a malformed-record error");
    } catch (error) {
      expect(JSON.stringify((error as AldusError).toStructuredError())).not.toContain(
        "SHOULD-NOT-APPEAR",
      );
    }
  });

  it("reads a record from a newer minor version and classifies it forward", async () => {
    const path = join(workspace.root, "episode.json");
    const [major] = SCHEMA_VERSION.split(".");
    await writeDocument(path, { ...anEpisode(), schemaVersion: `${major}.99` });

    const document = await readDocument(path, "EpisodeRef");
    expect(document?.compatibility).toBe("forward");
  });

  it("refuses a record from an incompatible major version", async () => {
    const path = join(workspace.root, "episode.json");
    await writeDocument(path, { ...anEpisode(), schemaVersion: "99.0" });
    await expect(readDocument(path, "EpisodeRef")).rejects.toThrow(
      /SCHEMA_VERSION_UNSUPPORTED|not readable/i,
    );
  });
});

describe("mergeForWrite", () => {
  it("carries an unknown property through a read-modify-write", async () => {
    const path = join(workspace.root, "episode.json");
    await writeDocument(path, { ...anEpisode(), unknownToThisBuild: { nested: [1, 2] } });

    const document = await readDocument(path, "EpisodeRef");
    expect(document).toBeDefined();
    if (document === undefined) return;
    // Validation strips it, which is exactly the hazard.
    expect("unknownToThisBuild" in document.value).toBe(false);

    const next = { ...document.value, title: "renamed" };
    await writeDocument(path, mergeForWrite(document, next));

    const reread = await readDocument(path, "EpisodeRef");
    expect(reread?.value.title).toBe("renamed");
    // And the raw bytes still carry the field this build never understood.
    expect(reread?.raw).toMatchObject({ unknownToThisBuild: { nested: [1, 2] } });
  });
});
