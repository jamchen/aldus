/**
 * The tool surface — what a transport binds to (contract §18, §18.1).
 *
 * Deliberately transport-agnostic. {@link AldusToolSurface.listTools} produces exactly what an
 * MCP `tools/list` response needs and {@link AldusToolSurface.callTool} exactly what
 * `tools/call` needs, so wiring an MCP server is a few lines in the host — see the package
 * README. §10.2 requires Aldus to remain operable if Remote Control changes or disappears, and a
 * package that hard-wired one transport would be a step toward the opposite.
 *
 * Workspace binding is fixed here, at construction (§19.2). No tool takes a workspace argument,
 * and every result echoes the bound root, so neither the agent nor an operator reading the
 * output has to infer which durable state was touched.
 */

import {
  AldusError,
  redact,
  toStructuredError,
  type ActorRef,
  type StructuredError,
} from "@aldus-runtime/core";
import { FileWorkspace } from "@aldus-runtime/file-store";
import { GateRegistry, type GateDefinition } from "@aldus-runtime/gate-engine";
import type { ArtifactArchive } from "@aldus-runtime/artifact-registry";
import type { ReleaseAdapter } from "@aldus-runtime/release";
import { StageRegistry } from "@aldus-runtime/stage-runner";
import {
  AldusContext,
  AldusServices,
  type Refusal,
  type ServiceResult,
  type SpendGrantProvider,
  type SubjectsProvider,
  type SynthesisAdapter,
} from "@aldus-runtime/services";

import { CapabilityGrant, type Capability } from "./capabilities.js";
import { McpErrorCodes, mcpError } from "./errors.js";
import { assertCallerIdentity, resolveActor, type CallerIdentity } from "./identity.js";
import {
  MUTATION_TOOLS,
  READ_TOOLS,
  type AldusTool,
  type CapabilityContext,
  type MutationTool,
  type ReadTool,
} from "./tools.js";

/** How a tool is advertised, shaped for an MCP `tools/list` response. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** JSON Schema draft 2020-12, generated from the tool's Zod schema (ADR-0002). */
  inputSchema: Record<string, unknown>;
  /** Which trust boundary this tool sits on (contract §18.1). */
  category: "read" | "mutation";
  /** Authority a caller must hold. Advertised so an agent can see what it lacks. */
  requiredCapabilities: readonly Capability[];
  /** False when the current session does not hold the authority this tool needs. */
  permitted: boolean;
}

/** What one tool call produced. */
export interface ToolCallResult {
  /** Which tool ran. */
  tool: string;
  /**
   * Mirrors the service outcome, plus `error` for anything genuinely broken.
   *
   * The distinctions matter to an agent the same way they matter to a script: `refused` means
   * wait or ask a human, `unsuccessful` means the work ran and stopped, `error` means the call
   * was wrong. Collapsing them would leave an agent retrying a refusal forever.
   */
  outcome: "ok" | "refused" | "unsuccessful" | "error";
  /** MCP's error flag. True for `refused` and `error`; a gate halt is not a tool failure. */
  isError: boolean;
  /** The bound workspace (contract §19.2), echoed so the acting scope is never ambiguous. */
  workspaceRoot: string;
  /**
   * The actor a mutation was attributed to (contract §19.2). Absent for reads.
   *
   * Present even when the call failed, because §20 asks who performed something and a failed
   * attempt is still an attempt. Whether anything was *recorded* is a separate question the
   * outcome answers.
   */
  actor?: ActorRef;
  /** Why that actor, when one was recorded. @see resolveActor */
  actorRationale?: string;
  /** Service payload, for `ok` and `unsuccessful`. */
  data?: unknown;
  /** Why the operation is not permitted right now (contract §13, §19.3). */
  refusal?: Refusal;
  /** Why it ran without succeeding. */
  explanation?: string;
  /** Structured, redacted failure detail (contract §19.1, §19.2). */
  error?: StructuredError;
}

/** Wiring for {@link AldusToolSurface}. */
export interface AldusToolSurfaceOptions {
  /**
   * Absolute path of the workspace this session acts on (contract §19.2 "worktree or workspace
   * binding MUST be explicit").
   *
   * Required, and never defaulted to the working directory: an inferred binding is the ambient
   * binding §19.2 rules out, and an agent that changed directory would silently change which
   * production state it was mutating.
   */
  workspaceRoot: string;
  /** Who is behind the session (contract §19.2, §10.1). */
  identity: CallerIdentity;
  /** Scoped authority, from host configuration only (contract §18.1). */
  capabilities: CapabilityGrant;
  /** Stage definitions available to run (contract §11). Host-supplied; §4.2 keeps them out of Core. */
  stages?: StageRegistry;
  /** Gate definitions in force (contract §13). */
  gates?: readonly GateDefinition[];
  /** Current digests of what gates bind (contract §13.2). */
  subjects?: SubjectsProvider;
  /**
   * Adapters that can reach release destinations (contract §17, §4.3).
   *
   * Host-supplied, like the stage and gate registries. ADR-0015 places composition with Aldus
   * and concrete adapters with the adopter: this package decides *when* an adapter is called and
   * refuses when policy is unmet; the adapter performs the call. §4.2 forbids Aldus from
   * importing one.
   *
   * With none wired, the release tools refuse rather than appearing to work.
   */
  releaseAdapters?: readonly ReleaseAdapter[];
  /**
   * Adapter that can perform synthesis (contract §15, §4.3).
   *
   * Reached only through a successful §13.2 authorization — see `synthesis.ts` in
   * `@aldus-runtime/services` for why it is unreachable rather than merely guarded. Supplying one
   * grants no authority; it only makes synthesis possible for calls that are already authorized.
   */
  synthesisAdapter?: SynthesisAdapter;
  /** Spend grants backing §13.2 authorization checks. */
  spendGrants?: SpendGrantProvider;
  /** Where irreplaceable artifacts are archived (contract §8.1). */
  archive?: ArtifactArchive;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
}

/** A capability-checked tool surface bound to one workspace. */
export class AldusToolSurface {
  readonly #options: AldusToolSurfaceOptions;
  readonly #services: AldusServices;
  readonly #stages: StageRegistry;
  readonly #tools: ReadonlyMap<string, AldusTool>;

  constructor(options: AldusToolSurfaceOptions) {
    if (options.workspaceRoot.trim().length === 0) {
      throw mcpError(
        McpErrorCodes.WORKSPACE_BINDING_REQUIRED,
        "The Production MCP must be bound to an explicit workspace root (contract §19.2). " +
          "Defaulting to the working directory would let the acting scope change without any " +
          "tool call saying so.",
        { category: "validation" },
      );
    }
    assertCallerIdentity(options.identity);

    this.#options = options;
    this.#stages = options.stages ?? new StageRegistry();

    const context = new AldusContext({
      workspace: new FileWorkspace(options.workspaceRoot),
      gates: GateRegistry.from(options.gates ?? []),
      stages: this.#stages,
      ...(options.subjects !== undefined ? { subjects: options.subjects } : {}),
      ...(options.releaseAdapters !== undefined
        ? { releaseAdapters: options.releaseAdapters }
        : {}),
      ...(options.synthesisAdapter !== undefined
        ? { synthesisAdapter: options.synthesisAdapter }
        : {}),
      ...(options.spendGrants !== undefined ? { spendGrants: options.spendGrants } : {}),
      ...(options.archive !== undefined ? { archive: options.archive } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.#services = new AldusServices(context);

    const tools = new Map<string, AldusTool>();
    for (const tool of [...READ_TOOLS, ...MUTATION_TOOLS]) tools.set(tool.name, tool);
    this.#tools = tools;
  }

  /** The workspace this surface acts on (contract §19.2). */
  get workspaceRoot(): string {
    return this.#options.workspaceRoot;
  }

  /**
   * Advertise the tools, with the authority each needs and whether this session holds it.
   *
   * Unpermitted tools are listed rather than hidden. An agent that cannot see a tool concludes
   * the capability does not exist and works around it; one that can see it is unauthorized asks
   * the operator to grant it — which is the outcome §18.1's boundary is meant to produce.
   */
  listTools(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      category: tool.category,
      requiredCapabilities: tool.requiredCapabilities,
      permitted: tool.requiredCapabilities.every((capability) =>
        this.#options.capabilities.has(capability),
      ),
    }));
  }

  /**
   * Validate, authorize, and run one tool call.
   *
   * Never throws: a transport needs a result to serialise, and an exception becomes a protocol
   * error the agent cannot read. Everything is mapped to a {@link ToolCallResult}.
   */
  async callTool(name: string, args: unknown = {}): Promise<ToolCallResult> {
    try {
      return await this.#dispatch(name, args);
    } catch (error) {
      return this.#failure(name, error);
    }
  }

  async #dispatch(name: string, args: unknown): Promise<ToolCallResult> {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      throw mcpError(McpErrorCodes.TOOL_UNKNOWN, `No tool named "${name}" is registered.`, {
        category: "not_found",
        details: { tool: name, available: [...this.#tools.keys()] },
      });
    }

    const parsed = tool.parse(args);
    if (!parsed.success) {
      throw mcpError(
        McpErrorCodes.TOOL_ARGUMENTS_INVALID,
        `Arguments for "${name}" did not satisfy its input schema.`,
        {
          category: "validation",
          // Path and code only — never the received value (§19.2). An agent may have put a
          // credential in a field, and echoing it back would place it in the transcript.
          details: { tool: name, issues: parsed.issues },
        },
      );
    }

    return tool.category === "read"
      ? await this.#callRead(tool, parsed.data)
      : await this.#callMutation(tool, parsed.data);
  }

  async #callRead(tool: ReadTool, args: unknown): Promise<ToolCallResult> {
    this.#options.capabilities.assert(tool.requiredCapabilities, tool.name);
    const result = await tool.invoke(this.#services, args);
    return this.#shape(tool.name, result, undefined);
  }

  async #callMutation(tool: MutationTool, args: unknown): Promise<ToolCallResult> {
    const context: CapabilityContext = {
      stageRequiresSpendAuthorization: (stageId, stageVersion) =>
        this.#requiresSpendAuthorization(stageId, stageVersion),
    };
    const required = [
      ...tool.requiredCapabilities,
      ...(tool.additionalCapabilities?.(args, context) ?? []),
    ];
    this.#options.capabilities.assert(required, tool.name);

    // §19.2: the actor is decided here, from how the host configured the session — never from
    // an argument. See identity.ts for why the default records the agent.
    const resolved = resolveActor(this.#options.identity);
    try {
      const result = await tool.invoke(this.#services, args, resolved.actor);
      return this.#shape(tool.name, result, resolved.actor, resolved.rationale);
    } catch (error) {
      // Attribute the failed attempt. §20 asks production trace "who or what performed it", and
      // an attempt that failed is still an attempt someone made — an operator reading a broken
      // release call should not have to guess which session tried it. Caught here rather than in
      // `callTool` because this is the only scope that knows the resolved actor.
      return this.#failure(tool.name, error, resolved.actor, resolved.rationale);
    }
  }

  /**
   * Whether a stage, as registered, declares that it needs a spend authorization (§19.3).
   *
   * Resolution mirrors the runner's: an explicit version, or the sole registered one. An
   * unresolvable stage is *not* treated as spend-free — the service will refuse it for its own
   * reasons, and guessing "no cost" for a stage nobody can identify is the wrong default when
   * the question is whether money can be spent.
   */
  #requiresSpendAuthorization(stageId: string, stageVersion?: string): boolean {
    const version = stageVersion ?? this.#soleVersionOf(stageId);
    if (version === undefined) return true;
    const definition = this.#stages.get(stageId, version);
    if (definition === undefined) return true;
    return definition.costPolicy?.requiresAuthorization === true;
  }

  #soleVersionOf(stageId: string): string | undefined {
    const versions = this.#stages.versionsOf(stageId);
    return versions.length === 1 ? versions[0] : undefined;
  }

  /** Map a service result onto the transport shape. */
  #shape(
    tool: string,
    result: ServiceResult<unknown>,
    actor: ActorRef | undefined,
    actorRationale?: string,
  ): ToolCallResult {
    const base = {
      tool,
      workspaceRoot: this.#options.workspaceRoot,
      ...(actor !== undefined ? { actor } : {}),
      ...(actorRationale !== undefined ? { actorRationale } : {}),
    };

    if (result.outcome === "refused") {
      return { ...base, outcome: "refused", isError: true, refusal: result.refusal };
    }
    if (result.outcome === "unsuccessful") {
      return {
        ...base,
        outcome: "unsuccessful",
        // Not an error: the work ran and stopped where §11 requires it to. Flagging it would
        // push an agent to retry a stage that is correctly waiting on a gate.
        isError: false,
        data: result.data,
        explanation: result.explanation,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    }
    return { ...base, outcome: "ok", isError: false, data: result.data };
  }

  /** Map a thrown failure onto the transport shape, redacted (§19.2). */
  #failure(
    tool: string,
    thrown: unknown,
    actor?: ActorRef,
    actorRationale?: string,
  ): ToolCallResult {
    const structured =
      thrown instanceof AldusError ? thrown.toStructuredError() : toStructuredError(thrown);
    return {
      tool,
      outcome: "error",
      isError: true,
      workspaceRoot: this.#options.workspaceRoot,
      ...(actor !== undefined ? { actor } : {}),
      ...(actorRationale !== undefined ? { actorRationale } : {}),
      error: redact(structured) as StructuredError,
    };
  }
}
