/**
 * Wiring a runner to a file-backed workspace.
 *
 * The runner itself depends only on the contract §7 ports, so a database-backed store can drive it
 * unchanged. This module is the convenience for the one adapter that exists today.
 */

import { join } from "node:path";

import type { ActorRef } from "@aldus/core";
import type { FileWorkspace } from "@aldus/file-store";

import type { AgentBackend } from "./backend.js";
import type { StageRegistry } from "./registry.js";
import { StageRunner, type StageRunnerOptions } from "./runner.js";

/**
 * Name of the stage-state cache inside a run directory.
 *
 * Contract §7's recommended layout lists six files and this is a seventh. The extension is
 * deliberate and recorded in ADR-0008: §7 says "recommended", the artifact registry already
 * extends the layout the same way, and this file is a rebuildable cache rather than a new source
 * of truth — deleting it costs nothing (§6.3 makes the materialized summary optional).
 */
export const STAGE_STATE_FILE = "stages.json";

/** Path of the stage-state cache for one Run. */
export function stageStatePathFor(workspace: FileWorkspace, runId: string): string {
  return join(workspace.layout.runDirectory(runId), STAGE_STATE_FILE);
}

/** Options for {@link createStageRunner}, minus the ports the workspace supplies. */
export type CreateStageRunnerOptions = Omit<
  StageRunnerOptions,
  "runs" | "events" | "locks" | "stageStatePath"
> & {
  registry: StageRegistry;
  actor: ActorRef;
  backend?: AgentBackend;
};

/** Build a {@link StageRunner} bound to a file-backed workspace. */
export function createStageRunner(
  workspace: FileWorkspace,
  options: CreateStageRunnerOptions,
): StageRunner {
  return new StageRunner({
    ...options,
    runs: workspace.runs,
    events: workspace.events,
    locks: workspace.locks,
    stageStatePath: (runId) => stageStatePathFor(workspace, runId),
  });
}
