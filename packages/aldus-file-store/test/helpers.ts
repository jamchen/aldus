/**
 * Shared test scaffolding.
 *
 * Every test runs against a real temp directory rather than a mocked filesystem. The failures
 * this package exists to survive — a torn write, a killed process, a stale lock — are properties
 * of a real filesystem, and a mock that returns whatever the test told it to return would assert
 * only that the test's own assumptions are self-consistent.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestContext, builders, omit, type TestContext } from "@aldus-runtime/testkit";
import type { AldusEvent, EpisodeRef, RunManifest } from "@aldus-runtime/core";

/** A temp workspace root, plus its cleanup. */
export interface TempWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

/** Create an isolated workspace directory under the OS temp dir. */
export async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "aldus-file-store-"));
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A deterministic builder context, so record identities are reproducible across runs. */
export function context(): TestContext {
  return createTestContext();
}

export function anEpisode(overrides: Partial<EpisodeRef> = {}, ctx = context()): EpisodeRef {
  return builders.EpisodeRef(overrides, ctx);
}

export function aRun(overrides: Partial<RunManifest> = {}, ctx = context()): RunManifest {
  return builders.RunManifest(overrides, ctx);
}

/**
 * An event as a caller would hand it to the store: with no `sequence`.
 *
 * The testkit builder populates `sequence` so its `full` fixture exercises every field, but the
 * store assigns sequences itself (ADR-0005). A caller that pre-set one would be asserting a
 * position in a log it has not read.
 */
export function anEvent(overrides: Partial<AldusEvent> = {}, ctx = context()): AldusEvent {
  const built = builders.AldusEvent(overrides, ctx);
  return "sequence" in overrides ? built : (omit(built, "sequence") as AldusEvent);
}
