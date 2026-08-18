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

import type { ArtifactRef, Reconstructability, StructuredError } from "@aldus-runtime/core";

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
 * Provenance only the stage knows (contract §8.1, §20).
 *
 * Deliberately narrow. The fields §8.1 names — which stage, run, code revision, and
 * configuration produced an artifact — are **not** here, because the runner supplies them from
 * the attempt. A stage cannot state them, so it cannot state them wrongly: an artifact whose
 * provenance disagrees with the attempt that produced it is unrepresentable rather than merely
 * discouraged.
 */
export interface StageProvenanceExtras {
  /**
   * Provider seed, where one was used (contract §8.1, §14.4).
   *
   * Recorded for trace only. §8.1 states a seed "MUST NOT be treated as a reproducibility
   * guarantee", and nothing re-derives an artifact from one.
   */
  providerSeed?: string;
  /** Knowledge Packs in force when the artifact was produced (contract §20). */
  knowledgePackIds?: readonly string[];
  /** Free-text note from the producer. Already redacted (§19.2). */
  note?: string;
}

/**
 * What a stage states about an output it wants registered (contract §8, §8.1).
 *
 * Everything here is something only the stage knows. Notice what is absent: `producerRunId`,
 * `producerStageId`, `codeRevision`, `configHash`, and `sha256`. The first four come from the
 * attempt, and the digest is computed from the bytes — §8.1 makes the digest half of an
 * artifact's identity, and §13 binds approvals to it, so a caller-supplied digest could bind an
 * approval to bytes nobody checked.
 */
export interface StageOutputRegistration {
  /** Path to the produced bytes. Hashed and sized by the registry. */
  path: string;
  /** What kind of artifact this is (contract §8.2). Open string; Core names no taxonomy (§4.2). */
  kind: string;
  /** IANA media type of the bytes. */
  mediaType: string;
  /**
   * How recoverable it is (contract §8).
   *
   * The one field a stage must get right and nothing else can supply: §8.1 makes
   * `irreplaceable` what stops a cleanup removing bytes a human already accepted and paid for.
   */
  reconstructability: Reconstructability;
  /** Digests of the inputs it was derived from (contract §8.1). Defaults to none. */
  inputHashes?: readonly string[];
  /** Provenance the attempt cannot know. @see StageProvenanceExtras */
  provenance?: StageProvenanceExtras;
  /** Artifact ID to use. Defaults to a freshly minted one. */
  artifactId?: string;
  /** URI recorded as the artifact's location. Defaults to a `file:` URI for `path`. */
  uri?: string;
}

/**
 * A registration with the attempt's own facts filled in (contract §8.1).
 *
 * Built by the runner, never by a stage. This is the shape an {@link ArtifactRecorder} receives.
 */
export interface ArtifactRecorderRequest extends StageOutputRegistration {
  /** Run that produced it — from the attempt, not the stage. */
  producerRunId: string;
  /** Stage that produced it — from the attempt, not the stage. */
  producerStageId: string;
  /** Revision of the runtime code, from the Run manifest. Absent when the Run records none. */
  codeRevision?: string;
  /** Digest of the exact configuration this attempt ran under (contract §11, §20). */
  configHash: string;
  /** The attempt's configuration, already redacted (contract §19.2). */
  configuration?: Record<string, unknown>;
}

/**
 * Somewhere to register a produced artifact (contract §8, ADR-0027).
 *
 * A **port**, not a dependency. `@aldus-runtime/artifact-registry` satisfies it structurally, and
 * this package deliberately does not import it: a runner depending on the registry would invert
 * the layering, and §7 requires core models to stay independent of physical storage. Whoever
 * composes the two wires them together (ADR-0015).
 */
export interface ArtifactRecorder {
  /** Hash the bytes, record the artifact, and return the reference. */
  register(request: ArtifactRecorderRequest): Promise<ArtifactRef>;
}

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
  readonly actor: import("@aldus-runtime/core").ActorRef;
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
  /**
   * Register a produced file and record it as an output, in one call.
   *
   * The preferred path. {@link StageContext.recordOutput} requires a stage to have obtained an
   * `ArtifactRef` from somewhere, which in practice means closing over a registry the stage
   * cannot reach until the context exists — a loop every adopter has had to break for itself.
   *
   * The provenance §8.1 demands is supplied from the attempt rather than by the stage: the run,
   * the stage, the code revision, and the configuration digest are all facts the runner already
   * holds. A stage states only what it knows, so the mismatch §8.1 exists to prevent is
   * unrepresentable rather than merely unlikely.
   *
   * The returned artifact is also recorded, so a stage never calls both for one file.
   *
   * @throws {AldusError} `ALDUS_ARTIFACT_RECORDER_UNAVAILABLE` when no recorder is wired. A
   * refusal rather than a silent no-op: a stage that believed it registered an irreplaceable
   * take and did not would discover it the day a cleanup removed the bytes.
   */
  registerOutput(registration: StageOutputRegistration): Promise<ArtifactRef>;
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
  /**
   * Gates that must be satisfied before this stage should be offered (contract §11 "stop at
   * required gates", §13).
   *
   * **Declarative here; enforced one layer up.** The runner cannot evaluate a gate — gate state
   * belongs to `@aldus-runtime/gate-engine`, which this package deliberately does not depend on —
   * so this field does not stop `run()` *within this package*. It tells the next-action policy
   * which gates actually gate this stage, so an unrelated pending gate no longer suppresses
   * unrelated work (ADR-0021).
   *
   * `@aldus-runtime/services` **does** refuse a stage whose declared gate is unsatisfied
   * (ADR-0024), because it holds both the gate engine and the subjects provider and so is the
   * layer where §11's "stop at required gates" can actually be honoured. Read in isolation this
   * field looks advisory; through the services it is not.
   *
   * **Do not gate a stage on a gate that binds that stage's own output.** The gate cannot be
   * decided until the artifact exists, the artifact does not exist until the stage runs, and the
   * stage will not run until the gate is decided — a deadlock with no action that clears it. It
   * is not detectable here: what a gate binds is adopter process supplied through a
   * `SubjectsProvider` (§4.2), so nothing relates a subject to the stage that produces it. A gate
   * approving a stage's output belongs on the stage that **consumes** that output. The first
   * adopter had three of these, harmless until gate enforcement landed and made them fatal.
   *
   * Absent means "not declared", which is not the same as "requires nothing": see ADR-0021 for
   * why an undeclared stage falls back to the conservative reading rather than being treated as
   * unblocked. Declare `[]` to say a stage genuinely requires no gate.
   *
   * A workflow graph supplied to the services overrides this per workflow, because one stage
   * definition may be reused by workflows that gate it differently.
   */
  requiredGates?: readonly string[];
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
