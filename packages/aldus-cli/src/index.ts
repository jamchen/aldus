/**
 * `@aldus-runtime/cli` — a thin adapter over `@aldus-runtime/services` (architecture contract §18).
 *
 * §18 makes the CLI and the Production MCP two adapters over one application-service layer. This
 * package parses argv, renders results, and chooses an exit code. Every decision — what is safe
 * to do next, whether a gate authorizes an operation, whether a stage may run — lives in
 * `@aldus-runtime/services`, so WP-11 inherits it rather than reimplementing it.
 *
 * @packageDocumentation
 */

export { run, type CliEnvironment } from "./cli.js";

export { loadConfig, stageRegistryOf, type AldusConfig } from "./config.js";

export { readJsonDocument, requireFlag } from "./documents.js";

export { ExitCodes, type ExitCode } from "./exit.js";

export {
  renderArchive,
  renderArtifactLineage,
  renderArtifacts,
  renderCleanupPlan,
  renderCosts,
  renderGateDecision,
  renderInit,
  renderInspection,
  renderPlan,
  renderRelease,
  renderReleaseBundle,
  renderReleaseExecution,
  renderReleaseReconciliation,
  renderScript,
  renderStageRun,
  renderStartRun,
  renderStatus,
  renderSynthesis,
  renderTakeDecision,
  renderTakes,
} from "./render.js";

export { USAGE } from "./usage.js";
