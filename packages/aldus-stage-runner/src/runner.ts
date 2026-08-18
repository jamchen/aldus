/**
 * The stage runner (architecture contract §22 WP-04, §11).
 *
 * §11 states seven obligations for every stage. Three are enforced by `definition.ts` in the type
 * system; the other four are enforced here:
 *
 * - **"record the exact configuration used"** — every attempt records a redacted copy of its
 *   configuration and a digest of it, so §20 can answer which configuration produced a result.
 * - **"expose safe retry behaviour"** — retry respects `StructuredError.retryable`, refuses whole
 *   categories of failure outright, and never auto-retries a stage that declared itself
 *   non-idempotent.
 * - **"avoid hidden mutation outside declared outputs"** — outputs arrive through
 *   `context.recordOutput`, which is also what makes partial success recoverable.
 * - **"stop at required gates"** — a gate halts the stage and records `waiting_for_gate`. The
 *   runner never decides a gate; that is WP-05.
 *
 * Locking follows ADR-0005: a lock is held for the duration of a *write*, never across execution.
 * A stage may run for minutes and §5.1 makes long pauses normal, so holding the Run lock across
 * `execute` would serialise a workspace on its slowest stage.
 */

import {
  assertValid,
  newEventId as defaultNewEventId,
  newStageAttemptId as defaultNewAttemptId,
  toStructuredError,
  redact,
  SCHEMA_VERSION,
  type ActorRef,
  type AldusEvent,
  type ArtifactRef,
  type RunManifest,
  type StageAttempt,
  type StageStatus,
  type StructuredError,
} from "@aldus-runtime/core";
import type { EventStore, LockManager, RunStore } from "@aldus-runtime/file-store";

import { assertCapabilities, type AgentBackend } from "./backend.js";
import {
  isGateRequiredSignal,
  type StageDefinition,
  type StageContext,
  type StageOutcome,
  type StageRunResult,
} from "./definition.js";
import { StageRunnerErrorCodes, stageRunnerError } from "./errors.js";
import type { StageRegistry } from "./registry.js";
import {
  STAGE_EVENT_ACTIONS,
  applyLifecycleEvent,
  digestJson,
  emptyStageState,
  readStageState,
  reconcileStageState,
  writeStageState,
  type AttemptMetadata,
  type StageLifecycleDetails,
  type StageStateFile,
  type StoredStageExecution,
} from "./state.js";

/**
 * Error categories that are never retried, whatever `retryable` says.
 *
 * A safety override, not a duplication of `StructuredError.retryable`. A stage is free to
 * construct a `policy` error with `retryable: true`, and §19.3 makes the consequence concrete:
 * retrying a refusal is how a spend limit gets spent through. §15.1 states the same rule for the
 * paid case directly — "Aldus MUST NOT silently retry paid requests without policy and cost
 * authorization". Refusals are decisions, and a decision does not become different by being asked
 * again.
 */
const NEVER_RETRIED_CATEGORIES: ReadonlySet<string> = new Set([
  "validation",
  "policy",
  "cancelled",
  "not_found",
]);

/** Everything the runner needs, expressed as ports rather than a concrete workspace. */
export interface StageRunnerOptions {
  /** Run manifests (contract §6.2). */
  runs: RunStore;
  /** The append-only event log (contract §6.4). */
  events: EventStore;
  /** Locking for state transitions (contract §19.1, ADR-0005). */
  locks: LockManager;
  /** Path of the `stages.json` cache for a Run. */
  stageStatePath: (runId: string) => string;
  /** Registered stage definitions (contract §11). */
  registry: StageRegistry;
  /** Who or what is running stages (contract §19.2). */
  actor: ActorRef;
  /** Backend whose capabilities are checked before execution (contract §10). */
  backend?: AgentBackend;
  /** Clock, injectable so tests produce reproducible timestamps. */
  now?: () => Date;
  /** Delay used between retries, injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Attempt ID minting, injectable for determinism. */
  newAttemptId?: () => string;
  /** Event ID minting, injectable for determinism. */
  newEventId?: () => string;
}

/** Per-invocation options. */
export interface RunStageOptions {
  /** Version of the stage definition to run. Defaults to the only registered version. */
  stageVersion?: string;
  /** Configuration recorded verbatim on every attempt (contract §11, §20). */
  configuration?: Record<string, unknown>;
  /** Artifacts declared as inputs (contract §11). */
  inputArtifacts?: readonly ArtifactRef[];
  /** Cancellation (contract §19.1). */
  signal?: AbortSignal;
  /**
   * Proceed even though the stage's latest attempt is `running`.
   *
   * A crashed runner leaves a stage claimed. Taking over is deliberate rather than automatic,
   * because the alternative — assuming a `running` stage is dead after some timeout — would let
   * two runners execute one side-effecting stage at once.
   */
  force?: boolean;
}

/** Drives stage attempts and records them (contract §22 WP-04). */
export class StageRunner {
  readonly #options: Required<
    Pick<StageRunnerOptions, "runs" | "events" | "locks" | "stageStatePath" | "registry" | "actor">
  > & {
    backend?: AgentBackend;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    newAttemptId: () => string;
    newEventId: () => string;
  };

  constructor(options: StageRunnerOptions) {
    this.#options = {
      runs: options.runs,
      events: options.events,
      locks: options.locks,
      stageStatePath: options.stageStatePath,
      registry: options.registry,
      actor: options.actor,
      ...(options.backend !== undefined ? { backend: options.backend } : {}),
      now: options.now ?? (() => new Date()),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      newAttemptId: options.newAttemptId ?? defaultNewAttemptId,
      newEventId: options.newEventId ?? defaultNewEventId,
    };
  }

  /** Current stage state for a Run, repaired from the log if a crash left the cache behind. */
  async stageState(runId: string): Promise<StageStateFile> {
    const path = this.#options.stageStatePath(runId);
    const cached = await readStageState(path);
    const { state, repaired } = await reconcileStageState(this.#options.events, runId, cached);
    if (repaired) await writeStageState(path, state);
    return state;
  }

  /** One stage's execution record, or `undefined` if it has never run. */
  async stageExecution(runId: string, stageId: string): Promise<StoredStageExecution | undefined> {
    const state = await this.stageState(runId);
    return state.stages.find((stage) => stage.execution.stageId === stageId);
  }

  /**
   * Run a stage to a terminal state, retrying within its policy.
   *
   * Returns rather than throws for an expected outcome — a failure, a cancellation, a gate halt.
   * Those are conditions an operator acts on (§20), and forcing every caller into `try`/`catch` to
   * read a gate halt would make the ordinary path the exceptional one. A misuse — an unregistered
   * stage, a missing capability, a stage already claimed — still throws.
   */
  async run<I = unknown, O = unknown>(
    runId: string,
    stageId: string,
    input: I,
    options: RunStageOptions = {},
  ): Promise<StageRunResult<O>> {
    const manifest = await this.#requireRun(runId);
    const definition = this.#resolve<I, O>(stageId, options.stageVersion);

    if (this.#options.backend !== undefined) {
      const capabilities = await this.#options.backend.capabilities();
      assertCapabilities(capabilities, definition.requiredCapabilities, {
        stageId: definition.id,
        backendId: this.#options.backend.id,
      });
    }

    const parsedInput = definition.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_INPUT_INVALID,
        `Input for stage "${definition.id}" does not satisfy its declared input schema ` +
          "(contract §11: every stage MUST validate its declared inputs).",
        {
          category: "validation",
          retryable: false,
          // The received value is deliberately absent: §19.2 forbids echoing input into a record
          // that will be logged, and a stage input can carry anything.
          details: { stageId: definition.id, stageVersion: definition.version },
        },
      );
    }

    const configuration = options.configuration ?? {};
    const configurationHash = digestJson(configuration);
    const inputArtifacts = [...(options.inputArtifacts ?? [])];

    await this.#assertClaimable(runId, definition, options.force ?? false);

    const maxAttempts = Math.max(1, definition.retryPolicy?.maxAttempts ?? 1);
    let ordinal = await this.#nextOrdinal(runId, definition.id);
    let lastResult: StageRunResult<O> | undefined;

    for (let tried = 0; tried < maxAttempts; tried += 1) {
      const result = await this.#attempt<I, O>({
        manifest,
        definition,
        input: parsedInput.data,
        configuration,
        configurationHash,
        inputArtifacts,
        ordinal,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      lastResult = result;

      if (result.status !== "failed") return result;
      if (tried + 1 >= maxAttempts) break;
      if (!this.#mayRetry(definition, result.error)) break;

      const delay = backoffFor(definition, tried);
      if (delay > 0) await this.#options.sleep(delay);
      ordinal += 1;
    }

    /* v8 ignore next 3 -- the loop runs at least once, so lastResult is always assigned. */
    if (lastResult === undefined) {
      throw stageRunnerError(StageRunnerErrorCodes.STAGE_EXECUTION_FAILED, "No attempt was made.", {
        category: "internal",
      });
    }
    return lastResult;
  }

  /* ---------------------------------------------------------------------------------------- */

  async #requireRun(runId: string): Promise<RunManifest> {
    const manifest = await this.#options.runs.get(runId);
    if (manifest === undefined) {
      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_STATE_INVALID,
        `Run "${runId}" does not exist, so no stage can be run against it.`,
        { category: "not_found", retryable: false, details: { runId } },
      );
    }
    return manifest;
  }

  #resolve<I, O>(stageId: string, stageVersion?: string): StageDefinition<I, O> {
    if (stageVersion !== undefined)
      return this.#options.registry.require<I, O>(stageId, stageVersion);
    const versions = this.#options.registry.versionsOf(stageId);
    if (versions.length !== 1) {
      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_NOT_REGISTERED,
        versions.length === 0
          ? `No stage is registered with id "${stageId}".`
          : `Stage "${stageId}" has ${versions.length} registered versions ` +
              `(${versions.join(", ")}), so the version to run must be stated explicitly. ` +
              "Picking one would make production trace ambiguous (contract §20).",
        {
          category: versions.length === 0 ? "not_found" : "validation",
          retryable: false,
          details: { stageId, registeredVersions: versions },
        },
      );
    }
    return this.#options.registry.require<I, O>(stageId, versions[0] as string);
  }

  /** Refuse to start a stage another runner is executing, or one parked on a gate. */
  async #assertClaimable(
    runId: string,
    definition: StageDefinition<never, unknown> | StageDefinition<unknown, unknown>,
    force: boolean,
  ): Promise<void> {
    const existing = await this.stageExecution(runId, definition.id);
    if (existing === undefined) return;
    const status = existing.execution.status;

    if (status === "waiting_for_gate") {
      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_STATE_INVALID,
        `Stage "${definition.id}" is waiting for a gate decision and cannot be run again until ` +
          "that decision is recorded (contract §13: human review is a first-class operation). " +
          "Deciding the gate is the gate engine's, not the runner's.",
        {
          category: "policy",
          retryable: false,
          details: {
            runId,
            stageId: definition.id,
            gateId: gateIdOf(existing),
            status,
          },
        },
      );
    }

    if (status === "running" && !force) {
      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_STATE_INVALID,
        `Stage "${definition.id}" is already running. If the runner that claimed it died, pass ` +
          "`force` to take over — deliberately, because assuming a running stage is dead would " +
          "let two runners execute one side-effecting stage at once (contract §19.1).",
        {
          category: "conflict",
          retryable: true,
          details: { runId, stageId: definition.id, status },
        },
      );
    }
  }

  async #nextOrdinal(runId: string, stageId: string): Promise<number> {
    const existing = await this.stageExecution(runId, stageId);
    if (existing === undefined) return 1;
    const highest = existing.execution.attempts.reduce(
      (max, attempt) => Math.max(max, attempt.attempt),
      0,
    );
    return highest + 1;
  }

  /** Whether a failed attempt may be retried automatically (contract §19.1, §15.1). */
  #mayRetry(
    definition: StageDefinition<never, unknown> | StageDefinition<unknown, unknown>,
    error: StructuredError | undefined,
  ): boolean {
    // A stage that told us re-running duplicates an external effect is never retried on its
    // behalf. §15.1: "Aldus MUST NOT silently retry paid requests without policy and cost
    // authorization." An operator can still re-run explicitly, having read the reason.
    if (definition.idempotency.kind === "not_idempotent") return false;
    if (error === undefined) return false;
    if (NEVER_RETRIED_CATEGORIES.has(error.category)) return false;
    return error.retryable;
  }

  async #attempt<I, O>(input: {
    manifest: RunManifest;
    definition: StageDefinition<I, O>;
    input: I;
    configuration: Record<string, unknown>;
    configurationHash: string;
    inputArtifacts: ArtifactRef[];
    ordinal: number;
    signal?: AbortSignal;
  }): Promise<StageRunResult<O>> {
    const { manifest, definition, ordinal } = input;
    const runId = manifest.runId;
    const attemptId = this.#options.newAttemptId();
    const controller = new AbortController();
    const outputs: ArtifactRef[] = [];
    const notes: string[] = [];

    const idempotencyKey =
      definition.idempotency.kind === "idempotent" && definition.idempotency.key !== undefined
        ? definition.idempotency.key(input.input)
        : digestJson({
            stageId: definition.id,
            stageVersion: definition.version,
            input: input.input,
            configuration: input.configuration,
          });

    const metadata: AttemptMetadata = {
      stageVersion: definition.version,
      configurationHash: input.configurationHash,
      configuration: redact(input.configuration) as Record<string, unknown>,
      idempotencyKey,
      idempotent: definition.idempotency.kind === "idempotent",
      ...(definition.idempotency.kind === "not_idempotent"
        ? { nonIdempotentReason: definition.idempotency.reason }
        : {}),
    };

    const base: StageAttempt = {
      attemptId,
      stageId: definition.id,
      attempt: ordinal,
      status: "queued",
      actor: this.#options.actor,
      inputArtifacts: input.inputArtifacts,
      outputArtifacts: [],
    };

    await this.#record(manifest, definition, base, metadata, {
      action: STAGE_EVENT_ACTIONS.attemptQueued,
      previousState: undefined,
      idempotencyKey,
    });

    const startedAt = this.#iso();
    const running: StageAttempt = { ...base, status: "running", startedAt };
    await this.#record(manifest, definition, running, metadata, {
      action: STAGE_EVENT_ACTIONS.attemptStarted,
      previousState: "queued",
      idempotencyKey,
    });

    // Cancellation is checked here as well as inside the stage: a stage that never looks at its
    // signal is still cancellable, just not promptly (contract §19.1).
    const onAbort = (): void => controller.abort(input.signal?.reason);
    if (input.signal !== undefined) {
      if (input.signal.aborted) controller.abort(input.signal.reason);
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    const context: StageContext = {
      runId,
      episodeId: manifest.episode.episodeId,
      stageId: definition.id,
      stageVersion: definition.version,
      attemptId,
      attempt: ordinal,
      actor: this.#options.actor,
      configuration: input.configuration,
      configurationHash: input.configurationHash,
      idempotencyKey,
      inputArtifacts: input.inputArtifacts,
      signal: controller.signal,
      recordOutput: (artifact) => {
        assertValid("ArtifactRef", artifact);
        outputs.push(artifact);
      },
      note: (message) => {
        notes.push(message);
      },
    };

    let outcome: StageOutcome<O> | undefined;
    let thrown: unknown;
    try {
      outcome = await definition.execute(context, input.input);
    } catch (error) {
      thrown = error;
    } finally {
      if (input.signal !== undefined) input.signal.removeEventListener("abort", onAbort);
    }

    const finishedAt = this.#iso();
    // Outputs are attached whatever happened. §19.1 requires recovery from partial success, and a
    // stage that produced two artifacts and then failed must leave both recorded and attributable
    // — otherwise the next attempt re-does paid work whose results already exist.
    const settled: StageAttempt = {
      ...running,
      outputArtifacts: [...outputs],
      finishedAt,
    };
    const withNotes: AttemptMetadata = notes.length > 0 ? { ...metadata, notes } : metadata;

    if (controller.signal.aborted) {
      return this.#terminal(manifest, definition, settled, withNotes, {
        status: "cancelled",
        idempotencyKey,
        error: cancellationError(definition.id, ordinal),
      });
    }

    if (thrown !== undefined) {
      if (isGateRequiredSignal(thrown)) {
        return this.#terminal(
          manifest,
          definition,
          settled,
          {
            ...withNotes,
            gateId: thrown.gateId,
            subjectHashes: [...thrown.subjectHashes],
          },
          {
            status: "waiting_for_gate",
            idempotencyKey,
            gateId: thrown.gateId,
          },
        );
      }
      return this.#terminal(manifest, definition, settled, withNotes, {
        status: "failed",
        idempotencyKey,
        error: redactError(
          toStructuredError(thrown, {
            code: StageRunnerErrorCodes.STAGE_EXECUTION_FAILED,
            category: "internal",
          }),
        ),
      });
    }

    /* v8 ignore next 3 -- execute either returns an outcome or throws. */
    if (outcome === undefined) {
      throw stageRunnerError(StageRunnerErrorCodes.STAGE_EXECUTION_FAILED, "No outcome.", {
        category: "internal",
      });
    }

    if (outcome.kind === "gate_required") {
      return this.#terminal(
        manifest,
        definition,
        settled,
        {
          ...withNotes,
          gateId: outcome.gateId,
          ...(outcome.subjectHashes !== undefined
            ? { subjectHashes: [...outcome.subjectHashes] }
            : {}),
        },
        {
          status: "waiting_for_gate",
          idempotencyKey,
          gateId: outcome.gateId,
        },
      );
    }

    const parsedOutput = definition.outputSchema.safeParse(outcome.output);
    if (!parsedOutput.success) {
      // §11: a stage must "produce declared outputs or a structured failure". A value that is
      // neither is the stage breaking its own contract, so this is a stage failure rather than a
      // runner crash — and it is recorded as one, with the outputs it did produce.
      return this.#terminal(manifest, definition, settled, withNotes, {
        status: "failed",
        idempotencyKey,
        error: {
          code: StageRunnerErrorCodes.STAGE_OUTPUT_INVALID,
          category: "validation",
          message:
            `Stage "${definition.id}" returned a value that does not satisfy its declared ` +
            "output schema (contract §11).",
          retryable: false,
          details: { stageId: definition.id, stageVersion: definition.version },
        },
      });
    }

    return this.#terminal<O>(manifest, definition, settled, withNotes, {
      status: "succeeded",
      idempotencyKey,
      output: parsedOutput.data,
    });
  }

  async #terminal<O>(
    manifest: RunManifest,
    definition: StageDefinition<never, unknown> | StageDefinition<unknown, unknown>,
    attempt: StageAttempt,
    metadata: AttemptMetadata,
    settle: {
      status: "succeeded" | "failed" | "cancelled" | "waiting_for_gate";
      idempotencyKey: string;
      output?: O;
      gateId?: string;
      error?: StructuredError;
    },
  ): Promise<StageRunResult<O>> {
    const final: StageAttempt = {
      ...attempt,
      status: settle.status,
      ...(settle.error !== undefined ? { error: settle.error } : {}),
    };

    await this.#record(manifest, definition, final, metadata, {
      action: actionFor(settle.status),
      previousState: "running",
      idempotencyKey: settle.idempotencyKey,
      ...(settle.error !== undefined ? { error: settle.error } : {}),
    });

    return {
      status: settle.status,
      attemptId: final.attemptId,
      attempt: final.attempt,
      outputArtifacts: [...final.outputArtifacts],
      ...(settle.output !== undefined ? { output: settle.output } : {}),
      ...(settle.gateId !== undefined ? { gateId: settle.gateId } : {}),
      ...(settle.error !== undefined ? { error: settle.error } : {}),
    };
  }

  /**
   * Append the lifecycle event, then update the cache — in that order, under the Run lock.
   *
   * §6.4 requires every state mutation to emit an event, so the event is the write that must not
   * be lost. A crash between the two leaves the log complete and the cache one event behind, which
   * `reconcileStageState` repairs. The opposite order would leave a state change with no audit
   * record, which nothing could repair because nothing would know it happened.
   */
  async #record(
    manifest: RunManifest,
    definition: StageDefinition<never, unknown> | StageDefinition<unknown, unknown>,
    attempt: StageAttempt,
    metadata: AttemptMetadata,
    options: {
      action: string;
      previousState: StageStatus | undefined;
      idempotencyKey: string;
      error?: StructuredError;
    },
  ): Promise<void> {
    const runId = manifest.runId;
    const details: StageLifecycleDetails = {
      attempt,
      metadata,
      executionStatus: attempt.status,
      stageVersion: definition.version,
    };

    const event: AldusEvent = {
      schemaVersion: SCHEMA_VERSION,
      eventId: this.#options.newEventId(),
      occurredAt: this.#iso(),
      episodeId: manifest.episode.episodeId,
      runId,
      stageId: attempt.stageId,
      attemptId: attempt.attemptId,
      action: options.action,
      actor: attempt.actor,
      ...(options.previousState !== undefined ? { previousState: options.previousState } : {}),
      resultingState: attempt.status,
      inputRefs: attempt.inputArtifacts.map((artifact) => artifact.artifactId),
      outputRefs: attempt.outputArtifacts.map((artifact) => artifact.artifactId),
      idempotencyKey: options.idempotencyKey,
      ...(options.error !== undefined ? { error: options.error } : {}),
      details: details as unknown as Record<string, unknown>,
    };

    // A resource of its own, not the Run lock. `FileEventStore.append` takes the Run lock itself
    // (ADR-0005 assigns the sequence under it), and a file lock is not re-entrant — nesting the
    // same resource deadlocks until the acquisition deadline. This lock serialises cache writers
    // among themselves while `append` keeps serialising the log.
    await this.#options.locks.withLock(stageStateLockResource(runId), async () => {
      const stored = await this.#options.events.append(runId, event);
      const path = this.#options.stageStatePath(runId);
      const current = await readStageState(path).catch(() => emptyStageState());
      await writeStageState(path, applyLifecycleEvent(current, stored));
    });
  }

  #iso(): string {
    return this.#options.now().toISOString();
  }
}

/**
 * Lock resource guarding one Run's stage-state cache.
 *
 * Deliberately distinct from `runLockResource`. The event store takes the Run lock to assign a
 * sequence (ADR-0005), and file locks are not re-entrant, so a runner holding the Run lock while
 * calling `append` would wait on itself until the acquisition deadline expired.
 */
export function stageStateLockResource(runId: string): string {
  return `stage-state-${runId}`;
}

/** Event action for a terminal status. */
function actionFor(status: "succeeded" | "failed" | "cancelled" | "waiting_for_gate"): string {
  switch (status) {
    case "succeeded":
      return STAGE_EVENT_ACTIONS.attemptSucceeded;
    case "failed":
      return STAGE_EVENT_ACTIONS.attemptFailed;
    case "cancelled":
      return STAGE_EVENT_ACTIONS.attemptCancelled;
    case "waiting_for_gate":
      return STAGE_EVENT_ACTIONS.attemptWaitingForGate;
  }
}

/** Delay before the attempt after `tried` completed attempts. */
function backoffFor(
  definition: StageDefinition<never, unknown> | StageDefinition<unknown, unknown>,
  tried: number,
): number {
  const backoff = definition.retryPolicy?.backoff;
  if (backoff === undefined) return 0;
  const raw = backoff.initialMs * backoff.factor ** tried;
  return Math.min(raw, backoff.maxMs);
}

/** The failure recorded for a cancelled attempt (contract §19.1). */
function cancellationError(stageId: string, ordinal: number): StructuredError {
  return {
    code: StageRunnerErrorCodes.STAGE_CANCELLED,
    category: "cancelled",
    message: `Attempt ${ordinal} of stage "${stageId}" was cancelled before it completed.`,
    retryable: false,
  };
}

/** Redact a structured error before it reaches a durable record (contract §19.2). */
function redactError(error: StructuredError): StructuredError {
  return redact(error) as unknown as StructuredError;
}

/** Gate a stage execution is parked on, if any. */
function gateIdOf(stored: StoredStageExecution): string | undefined {
  const latest = stored.execution.attempts.at(-1);
  return latest === undefined ? undefined : stored.metadata[latest.attemptId]?.gateId;
}
