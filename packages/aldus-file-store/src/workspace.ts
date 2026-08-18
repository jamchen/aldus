/**
 * A file-backed Aldus workspace.
 *
 * Wires the contract §7 layout, the lock manager, and the three stores into one object, so a
 * caller binds to a workspace once rather than threading paths through every call. Contract
 * §19.2 requires workspace binding to be explicit; constructing this is that binding.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WorkspaceLayout } from "./layout.js";
import { FileLockManager, type FileLockManagerOptions, type LockManager } from "./lock.js";
import { FileEpisodeStore, FileEventStore, FileRunStore } from "./stores.js";

/** Options for opening a workspace. */
export interface OpenWorkspaceOptions {
  /** Replace the default file-based lock manager, e.g. with a distributed lease. */
  locks?: LockManager;
  /** Tuning for the default lock manager. Ignored when `locks` is supplied. */
  lockOptions?: FileLockManagerOptions;
}

/** The file-backed stores for one workspace. */
export class FileWorkspace {
  readonly layout: WorkspaceLayout;
  readonly locks: LockManager;
  readonly episodes: FileEpisodeStore;
  readonly runs: FileRunStore;
  readonly events: FileEventStore;

  constructor(workspaceRoot: string, options: OpenWorkspaceOptions = {}) {
    this.layout = new WorkspaceLayout(workspaceRoot);
    this.locks =
      options.locks ?? new FileLockManager(this.layout.locksDirectory(), options.lockOptions ?? {});
    this.episodes = new FileEpisodeStore(this.layout, this.locks);
    this.runs = new FileRunStore(this.layout, this.locks);
    this.events = new FileEventStore(this.layout, this.locks);
  }
}

/**
 * Create the `.aldus` directory structure for a workspace.
 *
 * Idempotent. Writing a `.gitignore` inside `locks/` is deliberate: §7 recommends a Git-friendly
 * layout, and a committed lockfile would carry another machine's PID into everyone's checkout and
 * block the workspace until someone deleted it by hand.
 */
export async function initWorkspace(workspaceRoot: string): Promise<WorkspaceLayout> {
  const layout = new WorkspaceLayout(workspaceRoot);
  await mkdir(layout.runsDirectory(), { recursive: true });
  await mkdir(layout.locksDirectory(), { recursive: true });
  await writeFile(
    join(layout.locksDirectory(), ".gitignore"),
    "# Lockfiles are machine-local runtime state and must never be committed.\n*\n!.gitignore\n",
    "utf8",
  );
  return layout;
}

/** Open a workspace, creating its directory structure if absent. */
export async function openWorkspace(
  workspaceRoot: string,
  options: OpenWorkspaceOptions = {},
): Promise<FileWorkspace> {
  await initWorkspace(workspaceRoot);
  return new FileWorkspace(workspaceRoot, options);
}
