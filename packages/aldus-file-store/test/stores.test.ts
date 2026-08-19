/**
 * The file-backed stores end to end (contract §6.1, §6.2, §6.4, §7).
 */

import { readFile, writeFile, truncate, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AldusError, SCHEMA_VERSION, type AldusEvent } from "@aldus-runtime/core";
import { builders } from "@aldus-runtime/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileStoreErrorCodes } from "../src/errors.js";
import { RUN_COLLECTION_SCHEMAS, nextSequenceOf } from "../src/stores.js";
import { FileWorkspace, initWorkspace, openWorkspace } from "../src/workspace.js";

import {
  anEpisode,
  anEvent,
  aRun,
  context,
  makeTempWorkspace,
  type TempWorkspace,
} from "./helpers.js";

let temp: TempWorkspace;
let workspace: FileWorkspace;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  workspace = await openWorkspace(temp.root, { lockOptions: { retryMs: 1 } });
});

afterEach(async () => {
  await temp.cleanup();
});

describe("workspace initialisation", () => {
  it("creates the contract §7 directory structure", async () => {
    expect(await readFile(join(temp.root, ".aldus", "locks", ".gitignore"), "utf8")).toContain("*");
  });

  it("is idempotent", async () => {
    await expect(initWorkspace(temp.root)).resolves.toBeDefined();
    await expect(initWorkspace(temp.root)).resolves.toBeDefined();
  });

  it("reads an uninitialised workspace as empty rather than failing", async () => {
    const bare = await makeTempWorkspace();
    try {
      const fresh = new FileWorkspace(bare.root);
      expect(await fresh.episodes.get()).toBeUndefined();
      expect(await fresh.runs.list()).toEqual([]);
      expect(await fresh.runs.get("run-a")).toBeUndefined();
    } finally {
      await bare.cleanup();
    }
  });
});

describe("FileEpisodeStore", () => {
  it("round-trips an Episode", async () => {
    const episode = anEpisode();
    await workspace.episodes.put(episode);
    expect(await workspace.episodes.get()).toEqual(episode);
  });

  it("updates under a lock and returns the new value", async () => {
    await workspace.episodes.put(anEpisode());
    const updated = await workspace.episodes.update((current) => ({
      ...current,
      title: "Renamed Episode",
    }));
    expect(updated.title).toBe("Renamed Episode");
    expect((await workspace.episodes.get())?.title).toBe("Renamed Episode");
  });

  it("refuses to update an Episode that does not exist", async () => {
    try {
      await workspace.episodes.update((current) => current);
      expect.unreachable("expected a not-found error");
    } catch (error) {
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.RECORD_NOT_FOUND);
    }
  });

  it("rejects an update that produces an invalid record, leaving the stored one intact", async () => {
    const episode = anEpisode();
    await workspace.episodes.put(episode);
    await expect(
      workspace.episodes.update((current) => ({ ...current, showId: "" })),
    ).rejects.toThrow(AldusError);
    expect(await workspace.episodes.get()).toEqual(episode);
  });
});

describe("FileRunStore", () => {
  it("creates and reads a Run manifest", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    expect(await workspace.runs.get(run.runId)).toEqual(run);
    expect(await workspace.runs.list()).toEqual([run.runId]);
  });

  it("refuses to create a Run that already exists", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    try {
      await workspace.runs.create(run);
      expect.unreachable("expected an identity-mismatch error");
    } catch (error) {
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.RECORD_IDENTITY_MISMATCH);
    }
  });

  it("updates a Run manifest", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const updated = await workspace.runs.update(run.runId, (current) => ({
      ...current,
      status: "completed",
    }));
    expect(updated.status).toBe("completed");
    expect((await workspace.runs.get(run.runId))?.status).toBe("completed");
  });

  it("refuses an update that renames the Run", async () => {
    // Writing it would file one Run's state under another's identity.
    const run = aRun();
    await workspace.runs.create(run);
    try {
      await workspace.runs.update(run.runId, (current) => ({ ...current, runId: "run-other" }));
      expect.unreachable("expected an identity-mismatch error");
    } catch (error) {
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.RECORD_IDENTITY_MISMATCH);
    }
  });

  it("refuses to update a Run that does not exist", async () => {
    await expect(workspace.runs.update("run-absent", (current) => current)).rejects.toThrow(
      AldusError,
    );
  });

  it("serialises concurrent updates without losing one", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        workspace.runs.update(run.runId, (current) => ({
          ...current,
          knowledgePacks: [...current.knowledgePacks, builders.KnowledgePackRef()],
        })),
      ),
    );
    const final = await workspace.runs.get(run.runId);
    // Every update read the result of the previous one, so none was lost to a stale read.
    expect(final?.knowledgePacks).toHaveLength(run.knowledgePacks.length + 10);
  });

  describe.each(Object.keys(RUN_COLLECTION_SCHEMAS) as (keyof typeof RUN_COLLECTION_SCHEMAS)[])(
    "%s collection",
    (collection) => {
      it("reads as empty before anything is written", async () => {
        const run = aRun();
        await workspace.runs.create(run);
        expect(await workspace.runs.listRecords(run.runId, collection)).toEqual([]);
      });

      it("appends and reads back", async () => {
        const run = aRun();
        await workspace.runs.create(run);
        const schema = RUN_COLLECTION_SCHEMAS[collection];
        const record = builders[schema](undefined, context());

        await workspace.runs.addRecord(run.runId, collection, record as never);
        const stored = await workspace.runs.listRecords(run.runId, collection);
        expect(stored).toEqual([record]);
      });
    },
  );

  it("preserves unknown properties on existing collection elements", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const path = workspace.layout.runFilePath(run.runId, "artifacts");
    const existing = builders.ArtifactRef(undefined, context());
    await writeFile(
      path,
      JSON.stringify([{ ...existing, futureField: "keep me" }], null, 2),
      "utf8",
    );

    await workspace.runs.addRecord(
      run.runId,
      "artifacts",
      builders.ArtifactRef(undefined, context()),
    );

    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(Array.isArray(raw) && raw[0]).toMatchObject({ futureField: "keep me" });
  });

  it("names the offending index when a collection element is invalid", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const path = workspace.layout.runFilePath(run.runId, "costs");
    const valid = builders.CostRecord(undefined, context());
    await writeFile(path, JSON.stringify([valid, { nonsense: true }]), "utf8");

    try {
      await workspace.runs.listRecords(run.runId, "costs");
      expect.unreachable("expected a malformed-record error");
    } catch (error) {
      expect((error as AldusError).details).toMatchObject({ index: 1 });
    }
  });
});

describe("forward-record preservation through the store (ADR-0004)", () => {
  it("keeps a newer version's field across a read-modify-write", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const path = workspace.layout.runFilePath(run.runId, "manifest");

    // Simulate a newer build having written this manifest.
    const [major, minor] = SCHEMA_VERSION.split(".");
    const newer = {
      ...run,
      schemaVersion: `${major}.${Number(minor) + 5}`,
      fieldFromTheFuture: { kept: true },
    };
    await writeFile(path, JSON.stringify(newer, null, 2), "utf8");

    await workspace.runs.update(run.runId, (current) => ({ ...current, status: "running" }));

    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(raw.status).toBe("running");
    // The whole point: an older build touched the record and did not silently delete this.
    expect(raw.fieldFromTheFuture).toEqual({ kept: true });
    expect(raw.schemaVersion).toBe(`${major}.${Number(minor) + 5}`);
  });
});

describe("FileEventStore", () => {
  it("reads an empty log for a Run with no events", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    expect(await workspace.events.read(run.runId)).toEqual({ events: [] });
    expect(await workspace.events.nextSequence(run.runId)).toBe(0);
  });

  it("assigns ascending sequences and reads events back in order", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const ctx = context();

    for (let index = 0; index < 5; index += 1) {
      const stored = await workspace.events.append(
        run.runId,
        anEvent({ runId: run.runId, action: `stage.step.${index}` }, ctx),
      );
      expect(stored.sequence).toBe(index);
    }

    const result = await workspace.events.read(run.runId);
    expect(result.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(result.events.map((event) => event.action)).toEqual([
      "stage.step.0",
      "stage.step.1",
      "stage.step.2",
      "stage.step.3",
      "stage.step.4",
    ]);
  });

  it("rejects an explicitly supplied sequence that does not follow the log", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const ctx = context();
    await workspace.events.append(run.runId, anEvent({ runId: run.runId }, ctx));

    try {
      await workspace.events.append(run.runId, anEvent({ runId: run.runId, sequence: 7 }, ctx));
      expect.unreachable("expected an out-of-sequence error");
    } catch (error) {
      const aldusError = error as AldusError;
      expect(aldusError.code).toBe(FileStoreErrorCodes.EVENT_OUT_OF_SEQUENCE);
      expect(aldusError.details).toMatchObject({ expected: 1, received: 7 });
    }
  });

  it("rejects an event whose id is already in the log", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const ctx = context();
    const event = anEvent({ runId: run.runId }, ctx);
    await workspace.events.append(run.runId, event);

    try {
      await workspace.events.append(run.runId, { ...event, sequence: undefined });
      expect.unreachable("expected a duplicate-event error");
    } catch (error) {
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.EVENT_DUPLICATE);
    }
  });

  it("keeps a total order under concurrent appenders", async () => {
    // The reason a per-run sequence exists at all (ADR-0005): ULID monotonicity is a
    // single-process guarantee, so ordering must come from the store.
    const run = aRun();
    await workspace.runs.create(run);
    const ctx = context();

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        workspace.events.append(
          run.runId,
          anEvent({ runId: run.runId, action: `a.${index}` }, ctx),
        ),
      ),
    );

    const sequences = (await workspace.events.read(run.runId)).events.map((e) => e.sequence);
    expect(sequences).toEqual([...Array(12).keys()]);
  });

  it("recovers from a log truncated mid-line and appends after it", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const ctx = context();
    await workspace.events.append(run.runId, anEvent({ runId: run.runId, action: "a.0" }, ctx));
    await workspace.events.append(run.runId, anEvent({ runId: run.runId, action: "a.1" }, ctx));

    const path = workspace.layout.runFilePath(run.runId, "events");
    const size = (await readFile(path, "utf8")).length;
    await truncate(path, size - 30);

    const recovered = await workspace.events.read(run.runId);
    expect(recovered.events).toHaveLength(1);
    expect(recovered.tornTail).toBeTruthy();

    // A sequence derived from the highest surviving value, not the line count, so the new event
    // still sorts after everything durable.
    const appended = await workspace.events.append(
      run.runId,
      anEvent({ runId: run.runId, action: "a.2" }, ctx),
    );
    expect(appended.sequence).toBe(1);
  });

  it("refuses a log whose interior line is damaged", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const ctx = context();
    await workspace.events.append(run.runId, anEvent({ runId: run.runId }, ctx));

    const path = workspace.layout.runFilePath(run.runId, "events");
    const contents = await readFile(path, "utf8");
    await writeFile(path, `${contents}garbage-line\n${contents}`, "utf8");

    await expect(workspace.events.read(run.runId)).rejects.toThrow(AldusError);
  });

  it("refuses a log line that is JSON but not an AldusEvent", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    const path = workspace.layout.runFilePath(run.runId, "events");
    await mkdir(workspace.layout.runDirectory(run.runId), { recursive: true });
    await writeFile(path, '{"not":"an event"}\n', "utf8");

    try {
      await workspace.events.read(run.runId);
      expect.unreachable("expected a corruption error");
    } catch (error) {
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.EVENT_LOG_CORRUPT);
    }
  });
});

describe("nextSequenceOf", () => {
  it("starts at zero for an empty log", () => {
    expect(nextSequenceOf([])).toBe(0);
  });

  it("follows the highest sequence, not the count", () => {
    const events = [{ sequence: 0 }, { sequence: 9 }] as AldusEvent[];
    expect(nextSequenceOf(events)).toBe(10);
  });

  it("ignores events with no sequence", () => {
    const events = [{ sequence: undefined }, { sequence: 3 }] as AldusEvent[];
    expect(nextSequenceOf(events)).toBe(4);
  });
});

describe("a store holding records at more than one schema version (ADR-0003)", () => {
  /**
   * The state an incremental upgrade actually produces.
   *
   * ADR-0003 says any same-major record is readable, and every test that checked it used a
   * corpus stamped at one version — either all-current or all-newer. That never constructs the
   * case a real upgrade leaves behind: some records written before the bump, some after, in one
   * workspace, read in a single pass. The first adopter upgrade produced exactly that (37
   * records at the older minor, 1 at the current one) and reported it back, which is why this
   * fixture exists rather than a single-version one.
   *
   * Read through the stores, deliberately not through `checkSchemaVersion` — a version check
   * asked whether it agrees with itself will always say yes.
   */
  const olderMinor = (): string => {
    const [major, minor] = SCHEMA_VERSION.split(".");
    const previous = Number(minor) - 1;
    // The policy is same-major, so an older *minor* is the case worth constructing. At x.0 there
    // is no older minor and the newer direction is the only same-major variation available.
    return previous >= 0 ? `${major}.${previous}` : `${major}.${Number(minor) + 1}`;
  };

  it("reads runs stamped before and after a version bump in one pass", async () => {
    // Distinct ids: the builders are deterministic, so two bare aRun() calls collide.
    const older = aRun({ runId: "run_01AAAAAAAAAAAAAAAAAAAAAAAA" });
    const current = aRun({ runId: "run_01BBBBBBBBBBBBBBBBBBBBBBBB" });
    await workspace.runs.create(older);
    await workspace.runs.create(current);

    // Restamp one manifest as if written by the previous build. Only the stamp changes.
    const path = workspace.layout.runFilePath(older.runId, "manifest");
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...stored, schemaVersion: olderMinor() }), "utf8");

    const ids = await workspace.runs.list();
    expect(ids).toEqual(expect.arrayContaining([older.runId, current.runId]));

    // Both readable, and each still reports the version it was written at.
    expect((await workspace.runs.get(older.runId))?.schemaVersion).toBe(olderMinor());
    expect((await workspace.runs.get(current.runId))?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("reads an event log whose entries were written at different versions", async () => {
    const run = aRun();
    await workspace.runs.create(run);
    // Distinct event ids for the same reason the runs above need distinct run ids, and the
    // log is right to refuse a repeat: §6.4 makes it append-only.
    await workspace.events.append(
      run.runId,
      anEvent({ runId: run.runId, eventId: "evt_01AAAAAAAAAAAAAAAAAAAAAAAA" }),
    );
    await workspace.events.append(
      run.runId,
      anEvent({ runId: run.runId, eventId: "evt_01BBBBBBBBBBBBBBBBBBBBBBBB" }),
    );

    const path = workspace.layout.runFilePath(run.runId, "events");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const rewritten = [
      JSON.stringify({ ...first, schemaVersion: olderMinor() }),
      ...lines.slice(1),
    ].join("\n");
    await writeFile(path, `${rewritten}\n`, "utf8");

    const { events } = await workspace.events.read(run.runId);
    expect(events).toHaveLength(2);
    expect(events[0]?.schemaVersion).toBe(olderMinor());
    expect(events[1]?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("does not restamp an older record just because it was read", async () => {
    // The assertion that gives the two above their meaning. A runtime that silently migrated
    // records on read would pass both of them while destroying the evidence a rollback needs —
    // so if read-time migration is ever added, this check stops being able to detect it and must
    // be replaced rather than kept.
    const run = aRun();
    await workspace.runs.create(run);
    const path = workspace.layout.runFilePath(run.runId, "manifest");
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...stored, schemaVersion: olderMinor() }), "utf8");

    const before = await readFile(path, "utf8");
    await workspace.runs.get(run.runId);
    await workspace.runs.list();
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
