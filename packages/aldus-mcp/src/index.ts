/**
 * `@aldus-runtime/mcp` — the Production MCP tool surface (architecture contract §18, §18.1).
 *
 * A capability-checked adapter over `@aldus-runtime/services`, sibling to `@aldus-runtime/cli`. §18 makes both
 * adapters over one service layer, so nothing here decides whether an operation is safe,
 * interprets a gate, or reaches into a store — a decision made here is one the CLI would not
 * inherit, and two implementations of an approval path is the divergence §3.6 warns about.
 *
 * What this package adds beyond the CLI is the §18.1 trust boundary: read tools and mutating
 * tools are structurally separate, mutations require scoped authority granted by host
 * configuration, and the actor recorded against a mutation reflects that an agent made the call.
 *
 * The transport is deliberately absent (§10.2). {@link AldusToolSurface} produces exactly what
 * `tools/list` and `tools/call` need; see the package README for wiring.
 *
 * @packageDocumentation
 */

export {
  ALL_CAPABILITIES,
  CAPABILITIES,
  CapabilityGrant,
  type Capability,
} from "./capabilities.js";

export { McpErrorCodes, mcpError, type McpErrorCode } from "./errors.js";

export {
  OPERATOR_CONFIRMATIONS,
  assertCallerIdentity,
  resolveActor,
  type AgentIdentity,
  type CallerIdentity,
  type OperatorConfirmation,
  type OperatorIdentity,
  type ResolvedActor,
} from "./identity.js";

export {
  MUTATION_TOOLS,
  READ_TOOLS,
  mutationTool,
  readTool,
  type AldusTool,
  type CapabilityContext,
  type MutationTool,
  type ReadTool,
} from "./tools.js";

export {
  AldusToolSurface,
  type AldusToolSurfaceOptions,
  type ToolCallResult,
  type ToolDefinition,
} from "./surface.js";
