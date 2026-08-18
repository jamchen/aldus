/**
 * The executor against real file-backed storage.
 *
 * The in-memory ports elsewhere test the release logic. This file tests the wiring: receipts
 * landing in the Run's `release.json` (contract §7), events reaching the append-only log (§6.4),
 * and — the reason this file exists — that the executor takes no Run lock of its own.
 *
 * `RunStore.addRecord` and `EventStore.append` each acquire the Run lock, and file locks are not
 * re-entrant (ADR-0005). Code that held the Run lock while writing a receipt would be refused
 * with `ALDUS_LOCK_REENTRANT` on its very first write. That is easy to introduce and impossible
 * to notice without exercising the real stores, so it is exercised here.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWorkspace, type FileWorkspace } from "@aldus/file-store";
import { buildRunManifest, createTestContext } from "@aldus/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdapterRegistry, RecordingReleaseAdapter } from "../src/adapter.js";
import { authorizerHolding } from "./helpers.js";
import { ReleaseExecutor } from "../src/executor.js";
import { eventStoreSink, runStoreReceipts } from "../src/ports.js";
import {
  aBundle,
  DESTINATION_A,
  DESTINATION_B,
  OPERATOR,
  PUBLISH_AUTHORITY,
  RUN_ID,
  UPLOAD_AUTHORITY,
} from "./helpers.js";

let root: string;
let workspace: FileWorkspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aldus-release-"));
  workspace = await openWorkspace(root);
  const context = createTestContext();
  await workspace.runs.create(buildRunManifest({ runId: RUN_ID }, context));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeFileExecutor(): { executor: ReleaseExecutor; a: RecordingReleaseAdapter } {
  const a = new RecordingReleaseAdapter(DESTINATION_A);
  const b = new RecordingReleaseAdapter(DESTINATION_B);
  const executor = new ReleaseExecutor({
    adapters: new AdapterRegistry([a, b]),
    receipts: runStoreReceipts(workspace.runs),
    events: eventStoreSink(workspace.events),
    authorizer: authorizerHolding(UPLOAD_AUTHORITY, PUBLISH_AUTHORITY),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { executor, a };
}

describe("against the file store", () => {
  it("executes a whole bundle without tripping the re-entrant lock guard", async () => {
    // Both `addRecord` and `append` take the Run lock. If the executor held it too, this would
    // fail on the first receipt with ALDUS_LOCK_REENTRANT rather than completing (ADR-0005).
    const { executor } = makeFileExecutor();

    const outcome = await executor.execute(aBundle(), { actor: OPERATOR });

    expect(outcome.state).toBe("succeeded");
  });

  it("writes receipts into the Run's release collection (§7)", async () => {
    const { executor } = makeFileExecutor();
    await executor.execute(aBundle(), { actor: OPERATOR });

    const stored = await workspace.runs.listRecords(RUN_ID, "release");
    expect(stored.map((receipt) => receipt.operation)).toEqual([
      "media.upload",
      "visibility.transition",
      "thumbnail.set",
      "notification.send",
    ]);
  });

  it("appends an event per operation, sequenced by the store (§6.4, ADR-0005)", async () => {
    const { executor } = makeFileExecutor();
    await executor.execute(aBundle(), { actor: OPERATOR });

    const { events } = await workspace.events.read(RUN_ID);
    expect(events).toHaveLength(4);
    // Sequences are assigned by the store, so the log is totally ordered regardless of which
    // session wrote which line.
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("resumes from receipts that survived a restart", async () => {
    const first = makeFileExecutor();
    await first.executor.execute(aBundle(), { actor: OPERATOR });

    // A fresh executor over the same workspace, as a new CLI invocation would be.
    const second = makeFileExecutor();
    const outcome = await second.executor.execute(aBundle(), { actor: OPERATOR });

    expect(outcome.written).toEqual([]);
    expect(second.a.executed).toEqual([]);
    expect(outcome.state).toBe("succeeded");
  });

  it("stores receipts that validate as Core records", async () => {
    const { executor } = makeFileExecutor();
    await executor.execute(aBundle(), { actor: OPERATOR });

    // `listRecords` validates on read, so reaching here at all proves the shape. Assert the
    // fields §17 requires rather than trusting that.
    const stored = await workspace.runs.listRecords(RUN_ID, "release");
    for (const receipt of stored) {
      expect(receipt.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.runId).toBe(RUN_ID);
      expect(receipt.completedAt).toBeTruthy();
    }
  });
});
