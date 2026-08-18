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

export { ExitCodes, type ExitCode } from "./exit.js";

export {
  renderArtifacts,
  renderCosts,
  renderGateDecision,
  renderInit,
  renderInspection,
  renderRelease,
  renderStageRun,
  renderStartRun,
  renderStatus,
} from "./render.js";

export { USAGE } from "./usage.js";
