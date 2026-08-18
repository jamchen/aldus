/**
 * Failures specific to the Production MCP.
 *
 * Aldus Core keeps no central error-code registry, so a package names its own failures without
 * forking Core. These carry the same `ALDUS_` prefix and `SCREAMING_SNAKE_CASE` shape so
 * production trace (contract §20) stays uniform across packages.
 */

import { AldusError, type ErrorCategory } from "@aldus/core";

/** Error codes raised by the Production MCP adapter. */
export const McpErrorCodes = {
  /**
   * The caller does not hold the scoped authority a tool requires (contract §18.1).
   *
   * Not retryable: authority comes from host configuration, so no change of arguments helps.
   */
  CAPABILITY_REQUIRED: "ALDUS_MCP_CAPABILITY_REQUIRED",
  /** No tool is registered under the requested name. */
  TOOL_UNKNOWN: "ALDUS_MCP_TOOL_UNKNOWN",
  /** Tool arguments did not satisfy the tool's declared input schema. */
  TOOL_ARGUMENTS_INVALID: "ALDUS_MCP_TOOL_ARGUMENTS_INVALID",
  /**
   * A caller identity was configured that would misattribute a mutation (contract §19.2, §10.1).
   *
   * Raised when an operator identity is supplied whose actor kind is not `human`, since the
   * whole point of the operator slot is to name the person accountable for the session.
   */
  IDENTITY_INVALID: "ALDUS_MCP_IDENTITY_INVALID",
  /** The server was constructed without an explicit workspace binding (contract §19.2). */
  WORKSPACE_BINDING_REQUIRED: "ALDUS_MCP_WORKSPACE_BINDING_REQUIRED",
} as const;

/** @see McpErrorCodes */
export type McpErrorCode = (typeof McpErrorCodes)[keyof typeof McpErrorCodes];

/** Construct an {@link AldusError} with an MCP code. */
export function mcpError(
  code: McpErrorCode,
  message: string,
  options: { category: ErrorCategory; retryable?: boolean; details?: Record<string, unknown> },
): AldusError {
  return new AldusError(code, message, options);
}
