/**
 * Crash-safe write primitives (contract §19.1, §22 WP-02 "recovery from interrupted writes").
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendLineSynced,
  createExclusive,
  isNotFound,
  readFileOrUndefined,
  removeIfPresent,
  writeFileAtomic,
} from "../src/atomic.js";

import { makeTempWorkspace, type TempWorkspace } from "./helpers.js";

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

describe("writeFileAtomic", () => {
  it("writes a new file, creating parent directories", async () => {
    const path = join(workspace.root, "deep", "nested", "run.json");
    await writeFileAtomic(path, '{"a":1}');
    expect(await readFile(path, "utf8")).toBe('{"a":1}');
  });

  it("replaces existing contents", async () => {
    const path = join(workspace.root, "run.json");
    await writeFileAtomic(path, "first");
    await writeFileAtomic(path, "second");
    expect(await readFile(path, "utf8")).toBe("second");
  });

  // The failure the whole module exists to prevent: a process dies partway through replacing a
  // manifest, and the next read finds neither the old state nor the new one.
  it("leaves the previous contents intact when interrupted before the rename", async () => {
    const path = join(workspace.root, "run.json");
    await writeFileAtomic(path, '{"status":"running"}');

    await expect(
      writeFileAtomic(path, '{"status":"completed"}', {
        hooks: {
          beforeRename() {
            throw new Error("process killed mid-write");
          },
        },
      }),
    ).rejects.toThrow("process killed mid-write");

    expect(await readFile(path, "utf8")).toBe('{"status":"running"}');
  });

  it("leaves no temp file behind after an interrupted write", async () => {
    const path = join(workspace.root, "run.json");
    await writeFileAtomic(path, "original");

    await expect(
      writeFileAtomic(path, "replacement", {
        hooks: {
          beforeRename() {
            throw new Error("interrupted");
          },
        },
      }),
    ).rejects.toThrow();

    const entries = await readdir(workspace.root);
    expect(entries).toEqual(["run.json"]);
  });

  it("writes its temp file in the destination directory", async () => {
    // rename() is only atomic within one filesystem. A temp file in os.tmpdir() may be on a
    // different device, which silently degrades the rename into a non-atomic copy.
    const path = join(workspace.root, "runs", "run.json");
    let observed: string | undefined;
    await writeFileAtomic(path, "x", {
      hooks: {
        beforeRename(temporaryPath) {
          observed = temporaryPath;
        },
      },
    });
    expect(observed).toBeDefined();
    expect(observed).toContain(join(workspace.root, "runs"));
  });

  it("survives concurrent writers, leaving one complete value", async () => {
    const path = join(workspace.root, "run.json");
    const values = Array.from({ length: 20 }, (_, index) => `value-${index}`);
    await Promise.all(values.map((value) => writeFileAtomic(path, value)));
    expect(values).toContain(await readFile(path, "utf8"));
  });
});

describe("appendLineSynced", () => {
  it("creates the file and appends a newline-terminated line", async () => {
    const path = join(workspace.root, "events.jsonl");
    await appendLineSynced(path, '{"a":1}');
    await appendLineSynced(path, '{"a":2}');
    expect(await readFile(path, "utf8")).toBe('{"a":1}\n{"a":2}\n');
  });

  it("never interleaves bytes within a line under concurrency", async () => {
    // O_APPEND makes each write land at the current end of file, so concurrent appends can be
    // interleaved between lines but never inside one.
    const path = join(workspace.root, "events.jsonl");
    const lines = Array.from({ length: 50 }, (_, index) => JSON.stringify({ index }));
    await Promise.all(lines.map((line) => appendLineSynced(path, line)));

    const written = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(written).toHaveLength(50);
    expect(written.map((line) => JSON.parse(line).index).sort((a, b) => a - b)).toEqual(
      lines.map((_, index) => index),
    );
  });
});

describe("createExclusive", () => {
  it("creates a file and reports success", async () => {
    const path = join(workspace.root, "a.lock");
    expect(await createExclusive(path, "one")).toBe(true);
    expect(await readFile(path, "utf8")).toBe("one");
  });

  it("reports failure without overwriting an existing file", async () => {
    const path = join(workspace.root, "a.lock");
    await createExclusive(path, "one");
    expect(await createExclusive(path, "two")).toBe(false);
    expect(await readFile(path, "utf8")).toBe("one");
  });

  it("lets exactly one of many concurrent creators win", async () => {
    const path = join(workspace.root, "a.lock");
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) => createExclusive(path, `writer-${index}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("readFileOrUndefined and removeIfPresent", () => {
  it("returns undefined for a missing file rather than throwing", async () => {
    expect(await readFileOrUndefined(join(workspace.root, "absent.json"))).toBeUndefined();
  });

  it("tolerates removing a file that is not there", async () => {
    await expect(removeIfPresent(join(workspace.root, "absent.json"))).resolves.toBeUndefined();
  });

  it("removes a file that is there", async () => {
    const path = join(workspace.root, "present.json");
    await writeFile(path, "x", "utf8");
    await removeIfPresent(path);
    await expect(stat(path)).rejects.toSatisfy(isNotFound);
  });
});
