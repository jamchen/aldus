/**
 * Workspace layout.
 *
 * Paths follow architecture contract §7's recommended local layout verbatim. They are collected
 * here rather than spread through the stores because §8.1 states that a path MUST NOT be treated
 * as identity: keeping every path construction in one module makes it visible that paths are a
 * storage detail this adapter owns, and that no record's identity is derived from one.
 */

import { join } from "node:path";

/** Directory name holding Aldus state inside a workspace (contract §7). */
export const ALDUS_DIRECTORY = ".aldus";

/** File names inside a run directory (contract §7). */
export const RUN_FILES = {
  manifest: "run.json",
  events: "events.jsonl",
  artifacts: "artifacts.json",
  approvals: "approvals.json",
  costs: "costs.json",
  release: "release.json",
} as const;

/** @see RUN_FILES */
export type RunFileName = keyof typeof RUN_FILES;

/**
 * Resolves the contract §7 paths for one workspace.
 *
 * A run ID becomes a directory name, so it is validated before use: an identifier containing a
 * path separator or `..` would escape the workspace, and identifiers can originate from files
 * another machine wrote.
 */
export class WorkspaceLayout {
  readonly root: string;
  readonly aldusDirectory: string;

  constructor(workspaceRoot: string) {
    this.root = workspaceRoot;
    this.aldusDirectory = join(workspaceRoot, ALDUS_DIRECTORY);
  }

  /** `.aldus/episode.json` — the durable content identity (contract §6.1, §7). */
  episodePath(): string {
    return join(this.aldusDirectory, "episode.json");
  }

  /** `.aldus/runs` */
  runsDirectory(): string {
    return join(this.aldusDirectory, "runs");
  }

  /** `.aldus/runs/{run-id}` */
  runDirectory(runId: string): string {
    return join(this.runsDirectory(), assertPathSafe(runId));
  }

  /** A named file inside a run directory (contract §7). */
  runFilePath(runId: string, file: RunFileName): string {
    return join(this.runDirectory(runId), RUN_FILES[file]);
  }

  /**
   * `.aldus/locks` — lockfiles, which are machine-local runtime state.
   *
   * Deliberately a sibling of `runs/` rather than a file inside each run directory: §7's run
   * directory lists exactly six files, and a lockfile appearing among Git-tracked state would
   * invite committing another machine's PID.
   */
  locksDirectory(): string {
    return join(this.aldusDirectory, "locks");
  }
}

/** Resource name for the workspace-wide Episode record. */
export const EPISODE_LOCK_RESOURCE = "episode";

/** Resource name locking one Run. */
export function runLockResource(runId: string): string {
  return `run-${assertPathSafe(runId)}`;
}

/**
 * Reject an identifier that could escape its directory.
 *
 * Run IDs are minted by Core as `run_<ULID>`, but a workspace is shared and Git-tracked, so an
 * identifier read from disk is untrusted input.
 */
function assertPathSafe(identifier: string): string {
  if (
    identifier.length === 0 ||
    identifier === "." ||
    identifier === ".." ||
    identifier.includes("/") ||
    identifier.includes("\\") ||
    identifier.includes("\0")
  ) {
    throw new Error(
      `Identifier ${JSON.stringify(identifier)} cannot be used as a directory name: it is empty, ` +
        "a relative path segment, or contains a path separator.",
    );
  }
  return identifier;
}
