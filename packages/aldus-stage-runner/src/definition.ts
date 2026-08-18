/**
 * Stage definitions (architecture contract §11).
 *
 * §11 sketches `StageDefinition<I, O>` and then states seven obligations every stage MUST meet.
 * Three of them are enforced here in the type system rather than at runtime, because a rule the
 * compiler applies cannot be forgotten:
 *
 * - **"be idempotent or explicitly declare why it is not"** — {@link StageDefinition.idempotency}
 *   is required and its non-idempotent variant demands a reason. A stage cannot stay silent.
 * - **"validate its declared inputs"** and **"produce declared outputs or a structured failure"**
 *   — {@link StageDefinition.inputSchema} and `outputSchema` are required, and the runner applies
 *   both. A stage cannot opt out by leaving one undefined.
 *
 * The remaining obligations — recording configuration, safe retry, avoiding hidden mutation, and
 * stopping at gates — are the runner's to enforce, and are covered in `runner.ts`.
 */

import type { ArtifactRef, StructuredError } from "@aldus/core";

/**
 * The minimum a validator must offer for the runner to use it.
 *
 * Structurally satisfied by a Zod schema, so `z.object({…})` can be passed directly, but
 * deliberately *not* typed as one: contract §11 declares `inputSchema` and `outputSchema` as
 * `unknown`, and ADR-0002 makes Zod Core's choice rather than an obligation on adopters. A stage
 * authored against a different validator supplies an object of this shape instead.
 */
export interface StageSchema<T> {
  safeParse(value: unknown): StageSchemaResult<T>;
}

/** Outcome of a {@link StageSchema} check. */
export type StageSchemaResult<T> = { success: true; data: T } | { success: false; error?: unknown };

/**
 * Whether a stage can be re-run without duplicating external side effects (contract §11, §19.1).
 *
 * Not a boolean, because §11 requires a stage that is *not* idempotent to "explicitly declare why
 * it is not". A boolean records that the answer is no; this records the reason, which is what an
 * operator deciding whether to re-run actually needs (§20).
 */
export type StageIdempotency =
  | {
      kind: "idempotent";
      /**
       * Value distinguishing one invocation from another for deduplication (contract §19.1
       * "idempotency keys for external side effects").
       *
       * Defaults to a digest of the stage identity, its input, and its configuration. Override
       * when the natural key is narrower — for example when only part of the input determines the
       * external effect.
       */
      key?: (input: unknown) => string;
    }
  | {
      kind: "not_idempotent";
      /** Why re-running duplicates an effect. Recorded on every attempt and surfaced to operators. */
      reason: string;
    };

/** Retry backoff shape (contract §19.1 "retry classification and limits"). */
export interface RetryBackoff {
  /** Delay before the second attempt. */
  initialMs: number;
  /** Multiplier applied to each subsequent delay. */
  factor: number;
  /** Ceiling on any single delay. */
  maxMs: number;
}

/** How many times, and how fast, a stage may be retried (contract §19.1). */
export interface RetryPolicy {
  /**
   * Total attempts including the first. `1` disables retry.
   *
   * Counted rather than expressed as "retries" because §6.3's `attempt` ordinal is 1-based and
   * two different meanings of the same number is how off-by-one budgets happen.
   */
  maxAttempts: number;
  /** Delay schedule. Absent means retry immediately. */
  backoff?: RetryBackoff;
}

/** Spend limits for a stage that can incur cost (contract §19.3). */
export interface CostPolicy {
  /**
   * Whether the stage can preview its cost without incurring it (contract §19.3 "dry-run or cost
   * preview where possible").
   */
  supportsPreview: boolean;
  /**
   * Whether execution requires a recorded spend authorization (contract §13.2, §19.3).
   *
   * The runner records the requirement and refuses to auto-retry; *evaluating* the authorization
   * is WP-05's. A stage that sets this and is run without a decision is a WP-05 concern, not a
   * silent pass here.
   */
  requiresAuthorization: boolean;
}

/** What a stage may hand back to the runner. */
export type StageOutcome<O> =
  | { kind: "completed"; output: O }
  | {
      kind: "gate_required";
      /** Gate that must be decided before this stage can continue (contract §13). */
      gateId: string;
      /**
       * Hashes the eventual decision binds to (contract §13 `subjectHashes`).
       *
       * Recorded now so that WP-05 can bind an approval to exactly what the stage saw, and so
       * that a later change to those inputs invalidates the approval (§13.1, §13.2).
       */
      subjectHashes?: string[];
      /** Operator-facing explanation of what is being decided. */
      reason?: string;
    };

/**
 * What a stage is given when it runs.
 *
 * Everything the stage may legitimately touch arrives through here. §11 requires a stage to
 * "avoid hidden mutation outside declared outputs", and a context that carries its own output
 * channel is what makes the declared path the convenient one.
 */
export interface StageContext {
  /** Run this attempt belongs to (contract §6.2). */
  readonly runId: string;
  /** Canonical Episode identity (contract §6.1). */
  readonly episodeId: string;
  /** Stage being executed. */
  readonly stageId: string;
  /** Version of the stage definition in force. */
  readonly stageVersion: string;
  /** Identity of this attempt (contract §6.3). */
  readonly attemptId: string;
  /** 1-based ordinal of this attempt within the stage execution (contract §6.3). */
  readonly attempt: number;
  /** Who or what is performing this attempt (contract §19.2). */
  readonly actor: import("@aldus/core").ActorRef;
  /**
   * The exact configuration this attempt runs under (contract §11, §20).
   *
   * Recorded verbatim, and redacted before it reaches any durable record (§19.2).
   */
  readonly configuration: Readonly<Record<string, unknown>>;
  /** Digest of {@link configuration}, so §20 can answer "which configuration produced this". */
  readonly configurationHash: string;
  /** Deduplication key for external side effects (contract §19.1). */
  readonly idempotencyKey: string;
  /** Artifacts declared as inputs (contract §11). */
  readonly inputArtifacts: readonly ArtifactRef[];
  /**
   * Cancellation signal (contract §19.1).
   *
   * A long-running stage SHOULD check this. The runner also checks it around execution, so a
   * stage that ignores it is still cancellable — just not promptly.
   */
  readonly signal: AbortSignal;
  /**
   * Record an output artifact as soon as it exists.
   *
   * Called during execution rather than returned at the end, so that §19.1's "recovery from
   * partial success" is real: a stage that produced two artifacts and then failed leaves both
   * recorded and attributable, instead of losing them with the return value.
   */
  recordOutput(artifact: ArtifactRef): void;
  /** Emit an operator-facing progress note. Recorded on the attempt's events (contract §20). */
  note(message: string, details?: Record<string, unknown>): void;
}

/**
 * A versioned unit of work within a workflow (architecture contract §11).
 *
 * §3.7 and §11 both allow a stage to be coarse: a large existing script wrapped whole is a valid
 * stage, and boundaries "SHOULD become finer only when partial retry, observability, reuse, or
 * quality control justifies it". Nothing here requires decomposition.
 */
export interface StageDefinition<I = unknown, O = unknown> {
  /** Stable identity of the stage. An open string — workflows belong to adopters (§4.2). */
  id: string;
  /** Version of this definition. Recorded on every attempt so §20 can answer what ran. */
  version: string;
  /** Validator for the stage's input (contract §11 "validate its declared inputs"). */
  inputSchema: StageSchema<I>;
  /** Validator for the stage's output (contract §11 "produce declared outputs"). */
  outputSchema: StageSchema<O>;
  /**
   * Capabilities the executing backend must declare (contract §10).
   *
   * Open strings: §10 lists the *kinds* of capability a backend should declare, and §4.2 keeps
   * Core from enumerating backends. Checked before execution.
   */
  requiredCapabilities: readonly string[];
  /** Idempotency declaration. Required — §11 permits no silent answer. */
  idempotency: StageIdempotency;
  /** Spend limits, for a stage that can incur cost (contract §19.3). */
  costPolicy?: CostPolicy;
  /** Retry limits (contract §19.1). Absent means a single attempt. */
  retryPolicy?: RetryPolicy;
  /** Do the work. */
  execute(context: StageContext, input: I): Promise<StageOutcome<O>>;
}

/**
 * Thrown by a stage to stop at a gate (contract §11 "stop at required gates", §13).
 *
 * Provided as an alternative to returning `{ kind: "gate_required" }`, because a gate is often
 * discovered deep inside a stage where unwinding to a return value is awkward. The runner treats
 * both forms identically.
 */
export class GateRequiredSignal extends Error {
  readonly gateId: string;
  readonly subjectHashes: readonly string[];

  constructor(
    gateId: string,
    options: { subjectHashes?: readonly string[]; reason?: string } = {},
  ) {
    super(options.reason ?? `Stage stopped at gate "${gateId}" and is awaiting a decision.`);
    this.name = "GateRequiredSignal";
    this.gateId = gateId;
    this.subjectHashes = options.subjectHashes ?? [];
  }
}

/** Narrow an unknown thrown value to a {@link GateRequiredSignal}. */
export function isGateRequiredSignal(value: unknown): value is GateRequiredSignal {
  return value instanceof GateRequiredSignal;
}

/** Result of running a stage to a terminal state. */
export interface StageRunResult<O = unknown> {
  /** Final status of the stage execution (contract §6.3). */
  status: "succeeded" | "failed" | "waiting_for_gate" | "cancelled";
  /** Identity of the last attempt made. */
  attemptId: string;
  /** 1-based ordinal of the last attempt. */
  attempt: number;
  /** Validated output, present only when `status` is `succeeded`. */
  output?: O;
  /** Gate awaiting decision, present only when `status` is `waiting_for_gate`. */
  gateId?: string;
  /** Structured failure, present when `status` is `failed` or `cancelled`. */
  error?: StructuredError;
  /** Artifacts recorded across the final attempt, including on failure (contract §19.1). */
  outputArtifacts: ArtifactRef[];
}
