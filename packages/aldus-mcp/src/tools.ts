/**
 * The tool surface, split by trust boundary (contract §18.1).
 *
 * §18.1 requires read tools and mutating tools to be *separate trust boundaries*, not one list
 * with a severity flag. So they are two types with two constructors, and a read tool cannot be
 * placed in the mutation list or vice versa — the compiler refuses, and a phantom brand keeps a
 * hand-written literal from bypassing the constructors, which are where the invariants live.
 *
 * WP-12 reached the same conclusion for hard-gate versus best-effort release operations, for the
 * same reason: a boolean field gets set at a call site far from its consequence, and setting it
 * wrongly turns a mutation into something that looks broadly grantable. A type cannot be set
 * wrongly in passing.
 *
 * Every tool is a thin call into `@aldus/services`. Nothing here decides whether an operation is
 * safe, interprets a gate, or reaches into a store — §18 makes the CLI and this package two
 * adapters over one service layer, and a decision made here is one the CLI would not inherit.
 */

import { z } from "zod";
import type { ActorRef } from "@aldus/core";
import type { AldusServices, ServiceResult } from "@aldus/services";

import { CAPABILITIES, type Capability } from "./capabilities.js";

/**
 * Phantom tag separating the two categories.
 *
 * Erased at runtime. Present so an object literal cannot pass for a registered tool and skip
 * {@link readTool} / {@link mutationTool}, which is where capabilities are attached.
 */
declare const toolBrand: unique symbol;

/** One argument-validation failure, carrying no received value (contract §19.2). */
export interface ToolArgumentIssue {
  path: string;
  code: string;
}

/** Outcome of validating a tool's arguments. */
export type ToolParseResult =
  { success: true; data: unknown } | { success: false; issues: ToolArgumentIssue[] };

/** What every registered tool exposes, with its argument type erased. */
interface RegisteredToolBase {
  /** Tool name as the agent sees it. */
  readonly name: string;
  /** Short label for a tool picker. */
  readonly title: string;
  /**
   * What the tool does, written for an agent deciding whether to call it.
   *
   * Says what it changes and what authority it needs, because an agent that has to make a call
   * to discover it is not permitted will make that call.
   */
  readonly description: string;
  /** JSON Schema draft 2020-12, generated once at construction (ADR-0002). */
  readonly inputSchema: Record<string, unknown>;
  /** Validate arguments. Failure carries paths and codes only, never values (§19.2). */
  parse(args: unknown): ToolParseResult;
}

/**
 * A tool that only reads (contract §18.1 "read-oriented data tools MAY be broadly available").
 *
 * Requires no actor: §19.2 attaches identity to *mutations*, and requiring one to call `status`
 * would make §24's promise — that an operator can see current state without ceremony —
 * conditional on configuring identity first.
 */
export interface ReadTool extends RegisteredToolBase {
  readonly [toolBrand]: "read";
  readonly category: "read";
  /** Always exactly the read capability. Reads carry no finer authority. */
  readonly requiredCapabilities: readonly [typeof CAPABILITIES.read];
  invoke(services: AldusServices, args: unknown): Promise<ServiceResult<unknown>>;
}

/** What {@link MutationTool.additionalCapabilities} may consult. */
export interface CapabilityContext {
  /**
   * Whether a stage, as registered, declares that it requires a spend authorization
   * (contract §19.3 `CostPolicy.requiresAuthorization`).
   *
   * Supplied by the surface so this module needs no dependency on the stage runner.
   */
  stageRequiresSpendAuthorization(stageId: string, stageVersion?: string): boolean;
}

/**
 * A tool that changes durable state (contract §18.1).
 *
 * Carries an actor because §19.2 requires one, and declares capabilities because §18.1 requires
 * mutations to be authority-checked. Both are required: a mutation cannot be declared without
 * saying what it needs.
 */
export interface MutationTool extends RegisteredToolBase {
  readonly [toolBrand]: "mutation";
  readonly category: "mutation";
  /** Authority the caller must hold. Non-empty by construction. */
  readonly requiredCapabilities: readonly [Capability, ...Capability[]];
  /**
   * Extra authority implied by these particular arguments (contract §18.1).
   *
   * Where a tool's danger depends on what it is asked to do rather than which tool it is —
   * running a stage that can incur provider cost, forcing a claimed stage — the requirement is
   * derived per call rather than fixed on the tool.
   */
  additionalCapabilities?(args: unknown, context: CapabilityContext): readonly Capability[];
  invoke(services: AldusServices, args: unknown, actor: ActorRef): Promise<ServiceResult<unknown>>;
}

/** Any registered tool. */
export type AldusTool = ReadTool | MutationTool;

/** Authoring shape for a read tool, before erasure. */
interface ReadToolDefinition<A> {
  name: string;
  title: string;
  description: string;
  input: z.ZodType<A>;
  invoke(services: AldusServices, args: A): Promise<ServiceResult<unknown>>;
}

/** Authoring shape for a mutating tool, before erasure. */
interface MutationToolDefinition<A> {
  name: string;
  title: string;
  description: string;
  input: z.ZodType<A>;
  requiredCapabilities: readonly [Capability, ...Capability[]];
  additionalCapabilities?(args: A, context: CapabilityContext): readonly Capability[];
  invoke(services: AldusServices, args: A, actor: ActorRef): Promise<ServiceResult<unknown>>;
}

/**
 * `additionalProperties: false` is kept, unlike the stored-record schemas ADR-0002 strips it
 * from. That decision was about forward compatibility of *persisted records* — a reader must not
 * reject a record written by a newer minor version. Tool arguments are neither persisted nor
 * versioned: an unrecognised argument is a mistake the agent should hear about at once, not a
 * field from the future.
 */
function schemaOf<A>(input: z.ZodType<A>): Record<string, unknown> {
  return z.toJSONSchema(input, { target: "draft-2020-12" }) as Record<string, unknown>;
}

function parserOf<A>(input: z.ZodType<A>): (args: unknown) => ToolParseResult {
  return (args: unknown): ToolParseResult => {
    const parsed = input.safeParse(args);
    if (parsed.success) return { success: true, data: parsed.data };
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    };
  };
}

/** Declare a read tool. */
export function readTool<A>(definition: ReadToolDefinition<A>): ReadTool {
  const erased = {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: schemaOf(definition.input),
    parse: parserOf(definition.input),
    category: "read" as const,
    requiredCapabilities: [CAPABILITIES.read] as const,
    invoke: (services: AldusServices, args: unknown) => definition.invoke(services, args as A),
  };
  // The single cast in this module, and the reason the brand is unforgeable elsewhere: `args` is
  // only ever the output of `parse`, so the erasure is sound.
  return erased as unknown as ReadTool;
}

/** Declare a mutating tool. */
export function mutationTool<A>(definition: MutationToolDefinition<A>): MutationTool {
  const erased = {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: schemaOf(definition.input),
    parse: parserOf(definition.input),
    category: "mutation" as const,
    requiredCapabilities: definition.requiredCapabilities,
    ...(definition.additionalCapabilities !== undefined
      ? {
          additionalCapabilities: (args: unknown, context: CapabilityContext) =>
            definition.additionalCapabilities?.(args as A, context) ?? [],
        }
      : {}),
    invoke: (services: AldusServices, args: unknown, actor: ActorRef) =>
      definition.invoke(services, args as A, actor),
  };
  return erased as unknown as MutationTool;
}

// -------------------------------------------------------------------------------------------
// Shared argument pieces
// -------------------------------------------------------------------------------------------

const runIdArg = z.string().min(1).describe("Run identifier.");
const gateIdArg = z.string().min(1).describe("Gate identifier, as the workflow defines it.");

const gateDecisionInput = z
  .object({
    runId: runIdArg,
    gateId: gateIdArg,
    comment: z.string().max(4000).optional(),
    expiresOnChange: z.boolean().optional(),
  })
  .strict();

type GateDecisionArgs = z.infer<typeof gateDecisionInput>;

const stageInput = z
  .object({
    runId: runIdArg,
    stageId: z.string().min(1),
    stageVersion: z.string().min(1).optional(),
    input: z.unknown().optional(),
    configuration: z.record(z.string(), z.unknown()).optional(),
    force: z
      .boolean()
      .optional()
      .describe("Take over a stage claimed by a runner believed dead. Needs extra authority."),
  })
  .strict();

type StageArgs = z.infer<typeof stageInput>;

/**
 * Build the service request for a stage call.
 *
 * Optional fields are spread conditionally rather than passed through as `undefined`, because
 * `exactOptionalPropertyTypes` makes "absent" and "present and undefined" different shapes and
 * the services distinguish them.
 */
function stageRequest(args: StageArgs, actor: ActorRef) {
  return {
    runId: args.runId,
    stageId: args.stageId,
    ...(args.stageVersion !== undefined ? { stageVersion: args.stageVersion } : {}),
    ...(args.input !== undefined ? { input: args.input } : {}),
    ...(args.configuration !== undefined ? { configuration: args.configuration } : {}),
    ...(args.force !== undefined ? { force: args.force } : {}),
    actor,
  };
}

function gateRequest(args: GateDecisionArgs, actor: ActorRef) {
  return {
    runId: args.runId,
    gateId: args.gateId,
    ...(args.comment !== undefined ? { comment: args.comment } : {}),
    ...(args.expiresOnChange !== undefined ? { expiresOnChange: args.expiresOnChange } : {}),
    actor,
  };
}

/** Capabilities a stage call needs beyond `aldus:stage:run`. */
function stageExtras(args: StageArgs, context: CapabilityContext): readonly Capability[] {
  const extra: Capability[] = [];
  if (args.force === true) extra.push(CAPABILITIES.stageForce);
  if (context.stageRequiresSpendAuthorization(args.stageId, args.stageVersion)) {
    extra.push(CAPABILITIES.spend);
  }
  return extra;
}

// No tool takes a workspace argument. §19.2 requires workspace binding to be explicit, and the
// binding is the server's, fixed at construction. A workspace argument would let one session
// wander between workspaces — the caller choosing, per call, which durable state to change.

// -------------------------------------------------------------------------------------------
// Read tools
// -------------------------------------------------------------------------------------------

/** Read tools, in the order an operator would reach for them. */
export const READ_TOOLS: readonly ReadTool[] = [
  readTool({
    name: "aldus_status",
    title: "Production status",
    description:
      "Current state of the workspace and the next safe action, with reasons for anything " +
      "blocked (architecture contract §24). Read-only. Start here rather than inferring state " +
      "from earlier conversation — a session's memory is not authoritative (§3.4).",
    input: z
      .object({
        runId: runIdArg.optional().describe("Focus one Run. Omit when the workspace has only one."),
      })
      .strict(),
    invoke: (services, args) => services.status(args.runId),
  }),
  readTool({
    name: "aldus_inspect",
    title: "Inspect an Episode or Run",
    description:
      "Full detail for one Episode or Run, named by canonical identity or Run id " +
      "(contract §6.1, §6.2). Read-only.",
    input: z
      .object({ subject: z.string().min(1).describe("Canonical Episode identity or Run id.") })
      .strict(),
    invoke: (services, args) => services.inspect(args.subject),
  }),
  readTool({
    name: "aldus_artifacts",
    title: "List artifacts",
    description:
      "Artifacts a Run has produced, by identity and hash (contract §8). Read-only. A path is " +
      "not identity (§8.1) — address an artifact by id and digest.",
    input: z.object({ runId: runIdArg }).strict(),
    invoke: (services, args) => services.artifacts(args.runId),
  }),
  readTool({
    name: "aldus_costs",
    title: "Show costs",
    description:
      "Recorded and estimated cost for a Run (contract §19.3). Read-only. Shows what has been " +
      "spent; it neither authorizes nor previews new spend.",
    input: z.object({ runId: runIdArg }).strict(),
    invoke: (services, args) => services.costs(args.runId),
  }),
  readTool({
    name: "aldus_release_status",
    title: "Release status",
    description:
      "Release receipts recorded for a Run (contract §17). Read-only. This publishes nothing, " +
      "and no tool in this surface does.",
    input: z.object({ runId: runIdArg }).strict(),
    invoke: (services, args) => services.releaseStatus(args.runId),
  }),
];

// -------------------------------------------------------------------------------------------
// Mutating tools
// -------------------------------------------------------------------------------------------

/** Mutating tools. Every one declares the authority it needs (contract §18.1). */
export const MUTATION_TOOLS: readonly MutationTool[] = [
  mutationTool({
    name: "aldus_init",
    title: "Initialise workspace or Episode",
    description:
      "Create the workspace layout and optionally its Episode (contract §7, §6.1). Requires " +
      "aldus:workspace:init. Replacing an existing Episode is refused unless forced, because " +
      "Runs reference it.",
    requiredCapabilities: [CAPABILITIES.workspaceInit],
    input: z
      .object({
        episode: z
          .object({
            episodeId: z.string().min(1).optional(),
            showId: z.string().min(1),
            slug: z.string().min(1).optional(),
            title: z.string().min(1).optional(),
            legacyRef: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        force: z.boolean().optional(),
      })
      .strict(),
    invoke: (services, args, actor) => {
      const episode = args.episode;
      return services.init({
        ...(episode !== undefined
          ? {
              episode: {
                showId: episode.showId,
                ...(episode.episodeId !== undefined ? { episodeId: episode.episodeId } : {}),
                ...(episode.slug !== undefined ? { slug: episode.slug } : {}),
                ...(episode.title !== undefined ? { title: episode.title } : {}),
                ...(episode.legacyRef !== undefined ? { legacyRef: episode.legacyRef } : {}),
              },
            }
          : {}),
        ...(args.force !== undefined ? { force: args.force } : {}),
        actor,
      });
    },
  }),
  mutationTool({
    name: "aldus_start_run",
    title: "Start a Run",
    description:
      "Begin a Run of a workflow against this workspace's Episode (contract §6.2). Requires " +
      "aldus:run:start.",
    requiredCapabilities: [CAPABILITIES.runStart],
    input: z
      .object({
        workflowId: z.string().min(1),
        workflowVersion: z.string().min(1),
        runId: z.string().min(1).optional(),
        codeRevision: z.string().min(1).optional(),
      })
      .strict(),
    invoke: (services, args, actor) =>
      services.startRun({
        workflowId: args.workflowId,
        workflowVersion: args.workflowVersion,
        ...(args.runId !== undefined ? { runId: args.runId } : {}),
        ...(args.codeRevision !== undefined ? { codeRevision: args.codeRevision } : {}),
        actor,
      }),
  }),
  mutationTool({
    name: "aldus_run_stage",
    title: "Run a stage",
    description:
      "Execute one stage of a Run (contract §11). Requires aldus:stage:run; a stage that can " +
      "incur provider cost additionally requires aldus:spend, and taking over a stage another " +
      "runner has claimed additionally requires aldus:stage:force. Holding aldus:spend does " +
      "not authorize spend — §13.2 still requires a recorded, hash-bound approval, which this " +
      "call does not create.",
    requiredCapabilities: [CAPABILITIES.stageRun],
    input: stageInput,
    additionalCapabilities: stageExtras,
    invoke: (services, args, actor) => services.runStage(stageRequest(args, actor)),
  }),
  mutationTool({
    name: "aldus_retry_stage",
    title: "Retry a stage",
    description:
      "Re-attempt a stage (contract §6.3, §19.1). Attempts are append-only, so a retry appends " +
      "a new attempt and never edits one. Same authority as running a stage.",
    requiredCapabilities: [CAPABILITIES.stageRun],
    input: stageInput,
    additionalCapabilities: stageExtras,
    invoke: (services, args, actor) => services.retryStage(stageRequest(args, actor)),
  }),
  mutationTool({
    name: "aldus_approve_gate",
    title: "Record a gate approval",
    description:
      "Record an approval for a gate (contract §3.6, §13). Requires aldus:gate:decide. The " +
      "decision is recorded against the actor this session resolves to — the agent, unless the " +
      "host attested that a human confirmed this call. There is no argument asserting that a " +
      "human approved: §18.1 forbids one, and an approval an agent could assert would not be " +
      "an approval (§10.1).",
    requiredCapabilities: [CAPABILITIES.gateDecide],
    input: gateDecisionInput,
    invoke: (services, args, actor) => services.approve(gateRequest(args, actor)),
  }),
  mutationTool({
    name: "aldus_reject_gate",
    title: "Record a gate rejection",
    description: "Record a rejection for a gate (contract §3.6, §13). Requires aldus:gate:decide.",
    requiredCapabilities: [CAPABILITIES.gateDecide],
    input: gateDecisionInput,
    invoke: (services, args, actor) => services.reject(gateRequest(args, actor)),
  }),
  mutationTool({
    name: "aldus_request_changes",
    title: "Record a request for changes",
    description:
      "Record a changes-requested decision for a gate (contract §13). Requires aldus:gate:decide.",
    requiredCapabilities: [CAPABILITIES.gateDecide],
    input: gateDecisionInput,
    invoke: (services, args, actor) => services.requestChanges(gateRequest(args, actor)),
  }),
];
