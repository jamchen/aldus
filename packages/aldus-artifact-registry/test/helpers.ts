/**
 * Shared test scaffolding.
 *
 * Every test runs against a real temp directory. The failures this package exists to prevent —
 * one file overwriting another, an archive that does not hold what it claims, a cleanup that
 * deletes bytes nothing can regenerate — are properties of a real filesystem. A mocked one would
 * assert only that the test's own assumptions are self-consistent.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileLockManager, WorkspaceLayout, type LockManager } from "@aldus/file-store";

import { ArtifactRegistry, type ArtifactRegistryOptions } from "../src/registry.js";
import type { RegisterArtifactInput } from "../src/registry.js";

/** A temp workspace root, plus its cleanup. */
export interface TempWorkspace {
  root: string;
  locks: LockManager;
  cleanup(): Promise<void>;
}

/** Create an isolated workspace directory under the OS temp dir. */
export async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "aldus-artifact-registry-"));
  const layout = new WorkspaceLayout(root);
  await mkdir(layout.locksDirectory(), { recursive: true });
  return {
    root,
    locks: new FileLockManager(layout.locksDirectory()),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A registry over a temp workspace, with a fixed clock so records are reproducible. */
export function makeRegistry(
  workspace: TempWorkspace,
  options: ArtifactRegistryOptions = {},
): ArtifactRegistry {
  return new ArtifactRegistry(workspace.root, workspace.locks, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...options,
  });
}

/** Write a working file under the workspace, creating parents. Returns its absolute path. */
export async function writeWorkingFile(
  workspace: TempWorkspace,
  relativePath: string,
  contents: string,
): Promise<string> {
  const path = join(workspace.root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  return path;
}

/**
 * Registration input with sensible defaults.
 *
 * Every identifier is fictional (contract §4.2, §19.2): no show, host, provider, or platform is
 * named anywhere in this package's tests.
 */
export function registration(
  path: string,
  overrides: Partial<RegisterArtifactInput> = {},
): RegisterArtifactInput {
  return {
    path,
    kind: "kind-a",
    mediaType: "application/octet-stream",
    producerRunId: "run-a",
    producerStageId: "stage-a",
    reconstructability: "reproducible",
    provenance: {},
    ...overrides,
  };
}
