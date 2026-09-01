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
  MAX_ERROR_CODE_LENGTH,
  newEventId as defaultNewEventId,
  newStageAttemptId as defaultNewAttemptId,
  toStructuredError,
  redact,
  SCHEMA_VERSION,
  truncateErrorMessage,
  truncateErrorMessages,
  type ActorRef,
  type AldusEvent,
  type ArtifactRef,
  type CostExpectation,
  type RunManifest,
  type StageAttempt,
  type StageDispatchEvidence,
  type StageStatus,
  type StructuredError,
} from "@aldus-runtime/core";
import type { EventStore, LockManager, RunStore } from "@aldus-runtime/file-store";

import { assertCapabilities, type AgentBackend } from "./backend.js";
import { isChargeBearing } from "./paid-dispatch.js";
import type { StageAgentDispatcher, StageAgentDispatchResult } from "./agent-dispatch.js";
import type { PaidDispatchController, PaidDispatchReservation } from "./paid-dispatch.js";
import {
  isGateRequiredSignal,
  type ArtifactRecorder,
  type StageDefinition,
  type StageContext,
  type StageOutcome,
  type StageOutputRegistration,
  type StageRunResult,
  deriveInvocationKey,
  resolveArtifactContract,
  checkArtifactContract,
  type ArtifactObligation,
  type StageWorkerRequest,
  type StageAgentRequest,
  type EvaluationObservation,
  countEvaluationEvidence,
} from "./definition.js";
import { StageRunnerErrorCodes, stageRunnerError } from "./errors.js";
import { assertWorkerCapabilities, type WorkerRegistry, type WorkerResult } from "./worker.js";
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

/**
 * What is appended to the running-stage refusal for each answer the spend store can give (#244).
 *
 * `indeterminate` appends the empty string, so a runner with no port wired — or one whose port
 * declined — emits today's message byte for byte.
 *
 * The safe row is worded as a claim about **the store**, not about the world, and the distinction
 * is the whole of it: absence of a second reservation is not evidence there was no second effect,
 * and a sentence saying "nothing happened" would contradict the paragraph above it that says an
 * empty attempt is not evidence of that. Neither row lowers the friction; `--force` is required in
 * all three.
 */
const DISPATCH_EVIDENCE_SENTENCE: Record<StageDispatchEvidence, string> = {
  reserved_never_dispatched:
    " Every spend reservation this Run holds for this stage is `reserved` and none records a " +
    "dispatch, so no provider call was begun under an authorization Aldus holds (ADR-0044). That " +
    "is a fact about this workspace's reservation store, not about every effect the attempt could " +
    "have had.",
  dispatch_possible:
    " A reservation for this stage records that a dispatch was prepared, so a provider call may " +
    "have gone out and may already have been billed. Taking over may repeat a paid call.",
  indeterminate: "",
};

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
  /**
   * Whether a gate id a stage escalates to is one it can actually wait on.
   *
   * A port rather than a lookup, because the authority is the **workflow graph** and that lives in
   * the services layer: one stage definition may be reused by workflows that gate it differently
   * (ADR-0021), so a definition's own `requiredGates` is the fallback and not the answer.
   *
   * Absent means the declared gates are used where the stage declares any, and the id is accepted
   * where it declares none — which is the honest limit rather than a silent pass.
   */
  gateIsKnown?: (gateId: string, stageId: string) => boolean;
  /**
   * Whether a decision has been recorded for this gate on this Run (#240).
   *
   * The other half of `gateIsKnown`, and the half that was missing. A stage halting at a gate
   * records `waiting_for_gate`, and **nothing in the runtime ever cleared it** — so a gate that
   * was decided, on a stage nothing could restart, was the same permanent stop as an undecidable
   * one, with a human's approval sitting next to it. From the outside it reads worse, because the
   * record shows someone said yes.
   *
   * The predicate asks only whether a decision **exists**, not what it says. What a decision means
   * is the gate engine's and `requiredGates`' business, and duplicating that judgement here would
   * put a second, divergent copy of §13 in the runner. A rejection unparks the stage too: the
   * operator is entitled to act on the answer they got, and whatever the stage requires is still
   * enforced where it is enforced.
   *
   * Absent means the old behaviour — refuse — because a runner with no way to ask must not assume.
   */
  gateHasDecision?: (gateId: string, runId: string) => Promise<boolean>;
  /**
   * What the spend reservation store can establish about a stuck stage's dispatch window
   * (ADR-0044; `docs/design/spend-reservation-store.md` §5; #244).
   *
   * The third predicate of the same shape as `gateIsKnown` and `gateHasDecision`, and a port for
   * the same reason: the reservation store lives above this package and the runner must not reach
   * up to it.
   *
   * It changes **what an operator is told**, never what they may do — `--force` stays required in
   * every answer. The refusal today reports two entirely different situations identically: a stage
   * whose authorization was committed and whose provider was never called, and one that may already
   * have been billed. §5 records that distinction durably; nothing was reading it here.
   *
   * Absent means today's message, byte for byte. A runner with no way to ask must not assume the
   * safe row — the same rule `gateHasDecision` states one field up.
   */
  stageSpendEvidence?: (runId: string, stageId: string) => Promise<StageDispatchEvidence>;
  /** Who or what is running stages (contract §19.2). */
  actor: ActorRef;
  /** Backend whose capabilities are checked before execution (contract §10). */
  backend?: AgentBackend;
  /**
   * Where `context.registerOutput` sends produced files (contract §8, ADR-0027).
   *
   * A port rather than a registry: this package must not depend on
   * `@aldus-runtime/artifact-registry`, which is lower in the stack. Optional, so a runner used
   * for stages that produce no artifacts needs no wiring — but a stage that calls
   * `registerOutput` without one is refused rather than silently ignored.
   */
  artifacts?: ArtifactRecorder;
  /**
   * Workers a stage may invoke through {@link StageContext.runWorker} (§4.1, ADR-0035).
   *
   * Optional because most compositions have none. A stage that invokes a Worker without one is
   * refused rather than silently doing nothing — the same reason `registerOutput` refuses without
   * a recorder, and the same defect (#67) if it did not.
   */
  /**
   * Dispatches an agent execution for {@link StageContext.runAgent} (§10; #107, ADR-0047).
   *
   * A port rather than the service, so this package does not depend upward (§4.3). Optional
   * because a composition whose stages never call `runAgent` needs none — and a stage that calls
   * it without one is refused rather than silently doing nothing.
   *
   * Deliberately separate from {@link StageRunnerOptions.backend}. That field is a capability
   * source the runner checks a stage's declarations against; wiring it must never mean "dispatch
   * this", which is the reading that would turn configuration into an instruction.
   */
  agentDispatch?: StageAgentDispatcher;
  workers?: WorkerRegistry;
  /**
   * Reserves, settles and records what a paid Worker costs (§13.2, §19.3; #107, ADR-0046).
   *
   * A port rather than the service, so this package does not depend upward (§4.3). Optional
   * because a composition whose Workers are all free needs none — but a Worker invocation
   * declaring a paid expectation without one is **refused before dispatch**, not dispatched
   * hopefully. Fail-closed is the point: a spend check that is skipped when its enforcer is
   * unwired is a check whose presence depends on the configuration it exists to enforce.
   */
  paidDispatch?: PaidDispatchController;
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
    artifacts?: ArtifactRecorder;
    workers?: WorkerRegistry;
    agentDispatch?: StageAgentDispatcher;
    paidDispatch?: PaidDispatchController;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    newAttemptId: () => string;
    newEventId: () => string;
  };

  readonly #gateIsKnown: ((gateId: string, stageId: string) => boolean) | undefined;
  readonly #gateHasDecision: ((gateId: string, runId: string) => Promise<boolean>) | undefined;
  readonly #stageSpendEvidence:
    ((runId: string, stageId: string) => Promise<StageDispatchEvidence>) | undefined;

  /**
   * Whether this stage can wait on that gate.
   *
   * The validator is the authority where one is supplied; the stage's declared gates are the
   * fallback; and a stage that declares none cannot be checked here at all. That last case is a
   * real limit rather than a pass, and it is why the refusal names which check it applied.
   */
  #canWaitOn(
    gateId: string,
    definition: { id: string; requiredGates?: readonly string[] },
  ): boolean {
    if (this.#gateIsKnown !== undefined) return this.#gateIsKnown(gateId, definition.id);
    const declared = definition.requiredGates;
    return declared === undefined ? true : declared.includes(gateId);
  }

  /**
   * Record a refusal rather than an undecidable wait.
   *
   * `waiting_for_gate` on a gate nobody can decide is a permanent silent stop that reads as having
   * halted safely — the worst of the available outcomes, because nothing ever surfaces it. Every
   * automatic escalation path terminates at this signal, so an unresolvable id turns a bounded
   * loop's safe exit into a Run that never moves again (#220).
   */
  #undecidableGate<O>(
    manifest: RunManifest,
    definition: StageDefinition<never, unknown> | StageDefinition<unknown, unknown>,
    attempt: StageAttempt,
    metadata: AttemptMetadata,
    invocationKey: string,
    gateId: string,
  ): Promise<StageRunResult<O>> {
    return this.#terminal<O>(manifest, definition, attempt, metadata, {
      status: "failed",
      invocationKey,
      error: redactError(
        toStructuredError(
          stageRunnerError(
            StageRunnerErrorCodes.GATE_REQUIRED_UNKNOWN_GATE,
            `Stage "${definition.id}" stopped at gate "${gateId}", which is not a gate this stage ` +
              "can wait on. Recording it would leave the Run waiting on a decision nobody can " +
              "make, which reads as having stopped safely.",
            {
              category: "validation",
              retryable: false,
              details: { stageId: definition.id, gateId },
            },
          ),
          { code: StageRunnerErrorCodes.GATE_REQUIRED_UNKNOWN_GATE, category: "validation" },
        ),
      ),
    });
  }

  constructor(options: StageRunnerOptions) {
    this.#gateIsKnown = options.gateIsKnown;
    this.#gateHasDecision = options.gateHasDecision;
    this.#stageSpendEvidence = options.stageSpendEvidence;
    this.#options = {
      runs: options.runs,
      events: options.events,
      locks: options.locks,
      stageStatePath: options.stageStatePath,
      registry: options.registry,
      actor: options.actor,
      ...(options.backend !== undefined ? { backend: options.backend } : {}),
      ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
      ...(options.workers !== undefined ? { workers: options.workers } : {}),
      ...(options.agentDispatch !== undefined ? { agentDispatch: options.agentDispatch } : {}),
      ...(options.paidDispatch !== undefined ? { paidDispatch: options.paidDispatch } : {}),
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

    // Resolved before execution, from the validated invocation only (ADR-0040). Once per run
    // rather than per attempt, because the obligation is a property of what was asked for, not of
    // how many times it was tried.
    const expectedArtifacts = resolveArtifactContract(definition, {
      input: parsedInput.data,
      configuration,
      inputArtifacts,
    });

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
        ...(expectedArtifacts === undefined ? {} : { expectedArtifacts }),
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
      // The decision the refusal names, actually consulted. The message has always said "cannot be
      // run again until that decision is recorded" and nothing tested whether it was — a
      // description that drifted from its mechanism, in the sentence an operator reads while
      // holding the approval it says they need.
      const gateId = gateIdOf(existing);
      if (this.#gateHasDecision !== undefined && gateId !== undefined) {
        if (await this.#gateHasDecision(gateId, runId)) return;
      }
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
      // What this runner can and cannot see, rather than the worst case every time — and the
      // answer turned out to be less than the first adopter and I both assumed.
      //
      // They proposed that the runtime knows, at the moment it refuses, whether the stuck attempt
      // registered an artifact, so a takeover with nothing registered duplicates nothing. It does
      // not: **artifacts are written to the attempt when a stage settles**, and a stuck attempt by
      // definition has not. Reading zero there and reporting "nothing to duplicate" would claim
      // safety from evidence that cannot exist at that moment — ADR-0030's shape, in the message
      // that decides whether someone re-runs a paid stage.
      //
      // Measured, not reasoned: the first version of this counted `outputArtifacts` and its own
      // test showed zero for a stage that had recorded two.
      //
      // So the message says what it cannot answer and points at what can. §19.1's concern stands
      // undiminished; what changes is that the operator is no longer left to guess whether it
      // applies to them.
      // And what the reservation store *can* answer, which is not nothing (#244). The attempt
      // record cannot say whether a provider was called; the reservation stream can, because
      // `dispatch_prepared` is appended before the call precisely so this window is visible rather
      // than inferred (ADR-0044). Reading it changes only what the operator is told — `--force`
      // is still required in every one of the three answers below.
      const evidence = await this.#dispatchEvidence(runId, definition.id);

      throw stageRunnerError(
        StageRunnerErrorCodes.STAGE_STATE_INVALID,
        // Names the operator's flag, not the runner's parameter. `force` is what this function
        // takes; `--force` is what the person reading this has to type, and the first adopter read
        // "pass `force`" as naming something the CLI does not expose and filed it as unreachable.
        // It is reachable — but a remedy an operator cannot act on from the text they are given is
        // the same defect as one that does not exist, one step earlier.
        `Stage "${definition.id}" is already running. If the runner that claimed it died, pass ` +
          "`--force` to take over — `aldus run <stage> --run <id> --force`, or `force: true` from " +
          "a program. Deliberate by design, because assuming a running stage is dead would let two " +
          "runners execute one side-effecting stage at once (contract §19.1). This runner cannot " +
          "tell what the stuck attempt did: artifacts reach the record when a stage settles and " +
          "this one has not, and it holds no cost store — so an empty attempt is not evidence that " +
          "nothing happened. `aldus costs --run <id>` shows what the Run holds." +
          DISPATCH_EVIDENCE_SENTENCE[evidence],
        {
          category: "conflict",
          retryable: true,
          details: {
            runId,
            stageId: definition.id,
            status,
            dispatchEvidence: evidence,
          },
        },
      );
    }
  }

  /**
   * Ask the spend port, and treat every way of not getting an answer as not getting one (#244).
   *
   * A predicate that is unwired, that throws, or that reports `indeterminate` are three routes to
   * the same state: nothing was established. `DECLINED` is not a pass — a refusal to look must
   * never leave this method as the row that says no provider call was begun.
   */
  async #dispatchEvidence(runId: string, stageId: string): Promise<StageDispatchEvidence> {
    if (this.#stageSpendEvidence === undefined) return "indeterminate";
    try {
      return await this.#stageSpendEvidence(runId, stageId);
    } catch {
      return "indeterminate";
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
    if (definition.retrySafety.kind === "not_idempotent") return false;
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
    expectedArtifacts?: readonly ArtifactObligation[];
    ordinal: number;
    signal?: AbortSignal;
  }): Promise<StageRunResult<O>> {
    const { manifest, definition, ordinal } = input;
    const runId = manifest.runId;
    const attemptId = this.#options.newAttemptId();
    const controller = new AbortController();
    const outputs: ArtifactRef[] = [];
    // Counted per attempt: `keyScope: "stage"` is a claim about how many effects this attempt
    // performs, and nothing but a count can check it.
    let effectfulInvocations = 0;
    // Every invocation, effectful or not (#148). Recording only the effectful ones would leave an
    // auditor unable to tell a stage that declared no effects from one that predates the field.
    const workerInvocations: {
      workerId: string;
      workerVersion: string;
      effect: string;
      idempotencyKey?: string;
    }[] = [];
    const notes: string[] = [];

    // Two keys, because they are two contracts (ADR-0036). The invocation key fingerprints the
    // *declared work* for the trace; the effect key is what an external system deduplicates on and
    // is never derived by fallback. One value served both and was wrong for each: measured as a
    // constant per stage for any stage whose input is `{}`, which is the correct design for a
    // stage that resolves from the Run.
    const invocationKey = deriveInvocationKey({
      episodeId: input.manifest.episode.episodeId,
      stageId: definition.id,
      stageVersion: definition.version,
      input: input.input,
      configuration: input.configuration,
      inputArtifacts: input.inputArtifacts,
    });

    const retrySafety = definition.retrySafety;
    const effectKey =
      retrySafety.kind === "deduplicated_external_effects" && retrySafety.keyScope === "stage"
        ? retrySafety.effectKey({
            episodeId: input.manifest.episode.episodeId,
            stageId: definition.id,
            stageVersion: definition.version,
            input: input.input,
            configuration: input.configuration,
            inputArtifacts: input.inputArtifacts.map((artifact) => ({
              artifactId: artifact.artifactId,
              sha256: artifact.sha256,
            })),
          })
        : undefined;

    const metadata: AttemptMetadata = {
      stageVersion: definition.version,
      configurationHash: input.configurationHash,
      configuration: redact(input.configuration) as Record<string, unknown>,
      invocationKey,
      ...(effectKey !== undefined ? { effectKey } : {}),
      idempotent: retrySafety.kind !== "not_idempotent",
      // The declaration and its reason, on every attempt. The ruling on #148 is explicit that the
      // retry decision must *read and surface* these — recording them for a later audit is
      // insufficient, because an audit nobody performs is the better-documented silence a false
      // claim already provides.
      retrySafety: retrySafety.kind,
      ...(retrySafety.kind === "deduplicated_external_effects"
        ? { effectKeyScope: retrySafety.keyScope }
        : {}),
      ...("reason" in retrySafety ? { retrySafetyReason: retrySafety.reason } : {}),
      ...(retrySafety.kind === "not_idempotent" ? { nonIdempotentReason: retrySafety.reason } : {}),
    };

    const base: StageAttempt = {
      attemptId,
      stageId: definition.id,
      attempt: ordinal,
      status: "queued",
      actor: this.#options.actor,
      inputArtifacts: input.inputArtifacts,
      outputArtifacts: [],
      // Recorded on the attempt as it is created, so §20 can answer what was expected even if the
      // stage crashes before producing anything.
      ...(input.expectedArtifacts === undefined
        ? {}
        : { expectedArtifacts: input.expectedArtifacts.map((entry) => ({ ...entry })) }),
    };

    await this.#record(manifest, definition, base, metadata, {
      action: STAGE_EVENT_ACTIONS.attemptQueued,
      previousState: undefined,
      invocationKey,
    });

    const startedAt = this.#iso();
    const running: StageAttempt = { ...base, status: "running", startedAt };
    await this.#record(manifest, definition, running, metadata, {
      action: STAGE_EVENT_ACTIONS.attemptStarted,
      previousState: "queued",
      invocationKey,
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
      invocationKey,
      ...(effectKey !== undefined ? { effectKey } : {}),
      inputArtifacts: input.inputArtifacts,
      signal: controller.signal,
      recordOutput: (artifact) => {
        assertValid("ArtifactRef", artifact);
        outputs.push(artifact);
      },
      runWorker: async <WI, WO>(request: StageWorkerRequest<WI>) => {
        // The declarations are enforced before the Worker is reached, not after (#148). A refusal
        // arriving once an external system has been written to is not a refusal.
        //
        // Checked for presence first: the type requires it, so this catches the request that did
        // not come through the type — built from configuration, or written by a JavaScript
        // adopter. Without it the reads below throw a TypeError the runner reports as an ordinary
        // stage failure, which tells the author nothing about what they omitted.
        const effect = (request as { effect?: { kind?: string } }).effect;
        if (effect?.kind !== "none" && effect?.kind !== "deduplicated") {
          throw stageRunnerError(
            StageRunnerErrorCodes.STAGE_EFFECT_UNDECLARED,
            `Stage "${definition.id}" invoked Worker "${request.workerId}" without declaring ` +
              'whether the operation performs an external effect. State `effect: { kind: "none" }` ' +
              "or supply the key the destination deduplicates on (contract §19.1).",
            {
              category: "validation",
              retryable: false,
              details: { stageId: definition.id, workerId: request.workerId },
            },
          );
        }
        if (request.effect.kind === "deduplicated") {
          if (retrySafety.kind === "no_external_effects") {
            throw stageRunnerError(
              StageRunnerErrorCodes.STAGE_EFFECT_UNDECLARED,
              `Stage "${definition.id}" declares no external effects and asked a Worker to ` +
                "perform a deduplicated one. One of the two is wrong and the runtime cannot tell " +
                "which — but a stage claiming to touch nothing outside the workspace must not " +
                "write to a destination (contract §19.1).",
              {
                category: "validation",
                retryable: false,
                details: { stageId: definition.id, workerId: request.workerId },
              },
            );
          }
          if (request.effect.idempotencyKey.trim().length === 0) {
            throw stageRunnerError(
              StageRunnerErrorCodes.STAGE_EFFECT_KEY_REQUIRED,
              `Stage "${definition.id}" declared a deduplicated effect for Worker ` +
                `"${request.workerId}" and supplied an empty key. An empty key deduplicates ` +
                "nothing, and offering one is worse than declaring no effect at all.",
              {
                category: "validation",
                retryable: false,
                details: { stageId: definition.id, workerId: request.workerId },
              },
            );
          }
          effectfulInvocations += 1;
          // A stage-scoped key identifies one effect. A second effectful invocation has more
          // effects than that key can identify, and would proceed under a key describing the
          // first (#149).
          if (
            retrySafety.kind === "deduplicated_external_effects" &&
            retrySafety.keyScope === "stage" &&
            effectfulInvocations > 1
          ) {
            throw stageRunnerError(
              StageRunnerErrorCodes.STAGE_EFFECT_SCOPE_EXCEEDED,
              `Stage "${definition.id}" declares a stage-scoped effect key, which identifies ` +
                `exactly one external effect, and has now performed ${effectfulInvocations}. ` +
                "Declare per-invocation key scope so each effect carries its own key (§19.1).",
              {
                category: "validation",
                retryable: false,
                details: { stageId: definition.id, effectfulInvocations },
              },
            );
          }
        }
        workerInvocations.push({
          workerId: request.workerId,
          workerVersion: request.workerVersion,
          effect: effect.kind,
          ...(request.effect.kind === "deduplicated"
            ? { idempotencyKey: request.effect.idempotencyKey }
            : {}),
        });

        const registry = this.#options.workers;
        // Refuses rather than doing nothing. A capability that exists on the context and is
        // unreachable from every stage is #67 exactly, and a Worker seam nothing wired would be
        // the same defect one layer up.
        if (registry === undefined) {
          throw stageRunnerError(
            StageRunnerErrorCodes.WORKER_REGISTRY_UNAVAILABLE,
            `Stage "${definition.id}" invoked Worker "${request.workerId}", but no Worker ` +
              "registry is wired. Supply one when constructing the runner (§4.1, ADR-0035).",
            {
              category: "validation",
              retryable: false,
              details: { runId, stageId: definition.id, workerId: request.workerId },
            },
          );
        }

        const worker = registry.require(request.workerId, request.workerVersion);
        const workerCapabilities = await worker.capabilities();
        assertWorkerCapabilities(workerCapabilities, request.requiredCapabilities ?? [], {
          stageId: definition.id,
          workerId: worker.id,
          workerVersion: worker.version,
        });

        // Everything below happens **before** `worker.execute`. A refusal that arrives after the
        // provider was called is not a refusal, and a Worker may be paid — §3.2's own examples are
        // TTS invocation and rendering (#107).
        //
        // Checked for presence first, for the same reason `effect` is: the type requires it, so
        // this catches the request built from configuration or written by a JavaScript adopter.
        const declaration = (request as { spend?: { expectation?: { kind?: string } } }).spend;
        const expectation = declaration?.expectation;
        if (
          expectation?.kind !== "free" &&
          expectation?.kind !== "estimated" &&
          expectation?.kind !== "unestimated"
        ) {
          throw stageRunnerError(
            StageRunnerErrorCodes.WORKER_SPEND_UNDECLARED,
            `Stage "${definition.id}" invoked Worker "${request.workerId}" without declaring what ` +
              'it is expected to cost. State `spend: { expectation: { kind: "free" } }`, or an ' +
              "estimate with the operation and billing-effect identity that authorize it " +
              "(§13.2, §19.3).",
            {
              category: "validation",
              retryable: false,
              details: { stageId: definition.id, workerId: request.workerId },
            },
          );
        }

        const paid = expectation.kind !== "free";
        const spendController = this.#options.paidDispatch;
        // Required for **every** Worker dispatch, not only a paid one. A free declaration is a
        // belief about a provider, and the case that matters is when the belief is wrong: without
        // a sink the unexpected charge has nowhere durable to go, and the refusal below used to
        // tell the operator "the charge is recorded" while `recordUnauthorized` had silently done
        // nothing. Refusing beforehand is the only way that message can be true.
        if (spendController === undefined) {
          throw stageRunnerError(
            StageRunnerErrorCodes.WORKER_SPEND_UNAVAILABLE,
            `Stage "${definition.id}" invoked Worker "${request.workerId}" and no spend ` +
              "controller is wired. A paid invocation could not be reserved, and a free one could " +
              "not durably record a charge it did not expect — so neither can be dispatched " +
              "truthfully (§13.2, §19.3).",
            {
              category: "validation",
              retryable: false,
              details: { stageId: definition.id, workerId: request.workerId },
            },
          );
        }
        let reservation: PaidDispatchReservation | undefined;
        if (paid) {
          const paidDeclaration = declaration as unknown as {
            operation: string;
            billingEffectKey: string;
          };
          // Throws when no grant covers the operation, the scope excludes it, the budget is
          // exhausted, or the grant's policy refuses an unestimated request. Committed, not
          // checked: a check's answer is stale the moment another writer moves the stream.
          reservation = await spendController.reserve({
            operation: paidDeclaration.operation,
            billingEffectKey: paidDeclaration.billingEffectKey,
            expectation: expectation as Exclude<CostExpectation, { kind: "free" }>,
            runId,
            stageId: definition.id,
            attemptId,
            dispatcherId: worker.id,
            dispatcherVersion: worker.version,
          });
        }

        // A ceiling only where this exact Worker version says it enforces one, and the number is
        // always the grant's. Passing one to a Worker that ignores it would record a protection
        // that does not exist (ADR-0030); taking the number from the Worker would let the spender
        // choose its own limit.
        const enforcesCeiling = workerCapabilities.enforcesSpendCeiling === true;
        const ceiling = reservation?.ceiling;
        const appliedCeiling = enforcesCeiling && ceiling !== undefined ? ceiling : undefined;
        if (reservation !== undefined) {
          reservation = await spendController.prepareDispatch(reservation, {
            dispatcherId: worker.id,
            dispatcherVersion: worker.version,
            ceilingEnforced: appliedCeiling !== undefined,
            ...(appliedCeiling === undefined ? {} : { appliedCeiling }),
          });
        }

        // §20: the trace names which implementation ran and what was checked of it, before it
        // runs. A Worker recorded only on success would leave a failed invocation unattributable.
        notes.push(
          `worker ${worker.id}@${worker.version} invoked` +
            ((request.requiredCapabilities ?? []).length > 0
              ? ` (capabilities checked: ${(request.requiredCapabilities ?? []).join(", ")})`
              : ""),
        );

        const dispatched = async () =>
          worker.execute({
            input: request.input,
            runId,
            episodeId: manifest.episode.episodeId,
            stageId: definition.id,
            attemptId,
            configurationHash: input.configurationHash,
            inputHashes: input.inputArtifacts.map((artifact) => artifact.sha256),
            // Present only when this invocation declared a deduplicated effect and supplied its own
            // key (#149). It used to be `effectKey ?? invocationKey`, which did the one thing
            // ADR-0036 forbids in as many words: a fingerprint of declared work reaching an external
            // system as a deduplication credential. For a stage with an empty input schema and no
            // declared artifacts that fingerprint is a *constant*, so a platform deduplicating on it
            // would treat every episode's first request as a repeat of the first episode's, forever.
            //
            // A stage-level key is not propagated here either. It has a different cardinality, and
            // copying it onto every invocation is how N writes become one.
            ...(request.effect.kind === "deduplicated"
              ? { idempotencyKey: request.effect.idempotencyKey }
              : {}),
            ...(appliedCeiling === undefined ? {} : { maxSpend: appliedCeiling }),
            signal: controller.signal,
          });

        let result: WorkerResult<unknown>;
        try {
          result = await dispatched();
        } catch (thrown) {
          // After `prepareDispatch` a failure is not proof of no charge (ADR-0044). The
          // reservation stays committed and the effect becomes non-retryable, because assuming a
          // failed request cost nothing is how a budget is quietly exceeded (§19.3).
          if (reservation !== undefined) {
            await spendController.markUnknown(
              reservation,
              `Worker "${worker.id}@${worker.version}" threw after dispatch, so whether it was ` +
                "charged is unknown.",
            );
          }
          throw thrown;
        }

        // Settlement, before the result reaches the stage. `WorkerResult.costs` used to be handed
        // straight back and read by nothing — a Worker that knew what it spent had its answer
        // discarded one line after the call (#107).
        const observations = result.costs ?? [];
        // Billing semantics, not array length. `free` and `voided` are a provider stating that
        // nothing is owed, which is evidence of no spend rather than a charge to account for — so
        // a Worker that truthfully reports `billingStatus: "free"` is not diverging from a free
        // declaration, and a paid one reporting only those has not gone silent about billing.
        const charges = observations.filter((observation) =>
          isChargeBearing(observation.billingStatus),
        );
        if (reservation !== undefined) {
          // One `billingEffectKey` names one independently billed effect and commits one
          // reservation for it. A result carrying several independent charges is a cardinality the
          // declaration cannot describe, and settling them together would let one authorization
          // cover N — exactly what per-charge identity exists to prevent (ADR-0043, ADR-0046).
          //
          // The money is already spent, so the facts are persisted and attributed and the
          // reservation is retained unresolved. What is withheld is the claim that it covered them.
          if (charges.length > 1) {
            await spendController.markUnknown(
              reservation,
              `Worker "${worker.id}@${worker.version}" reported ${charges.length} independently ` +
                "billed charges against one declared billing effect. One reservation authorizes " +
                "one charge; declare one invocation per billed effect.",
              observations,
            );
            throw stageRunnerError(
              StageRunnerErrorCodes.WORKER_SPEND_CARDINALITY,
              `Stage "${definition.id}" declared one billing effect for Worker "${worker.id}" ` +
                `and it reported ${charges.length} independent charges. They are recorded and the ` +
                "reservation is left unresolved: settling them against one authorization would " +
                "let a single approval cover several charges (§13.2, §19.3).",
              {
                category: "conflict",
                retryable: false,
                details: { stageId: definition.id, workerId: worker.id },
              },
            );
          }
          // Silence, not "no charges". A result carrying only `free`/`voided` observations is a
          // provider stating nothing is owed, and settlement releases on it; a result carrying
          // nothing at all is a Worker that said nothing about billing, which is the unknown case.
          if (observations.length === 0) {
            // Dispatched under a reservation and came back saying nothing about billing. The
            // charge may have landed and nobody can measure it, so the reservation is retained
            // and the effect becomes non-retryable rather than being released as free (§19.3).
            //
            // A result carrying only `free`/`voided` observations does **not** reach here: that is
            // a provider stating nothing is owed, which `settle` releases on.
            await spendController.markUnknown(
              reservation,
              `Worker "${worker.id}@${worker.version}" was dispatched under a paid expectation ` +
                "and returned no billing facts, so whether it was charged is unknown.",
              observations,
            );
            throw stageRunnerError(
              StageRunnerErrorCodes.WORKER_BILLING_UNKNOWN,
              `Worker "${worker.id}@${worker.version}" was dispatched for stage ` +
                `"${definition.id}" under a paid expectation and reported no cost. Retrying would ` +
                "spend again on the assumption the first call was free (§19.3).",
              {
                category: "conflict",
                retryable: false,
                details: { stageId: definition.id, workerId: worker.id },
              },
            );
          }
          // Records are durable before authorization is released. The reverse would free the
          // budget while the charge is absent from the record (ADR-0044).
          await spendController.settle(reservation, observations);
        } else if (charges.length > 0) {
          // Declared free and charged anyway. Recorded so §20 can answer what the Run cost, and
          // deliberately not attached to a grant: laundering it through one nobody consulted
          // would invent an approval.
          await spendController.recordUnauthorized(
            {
              runId,
              stageId: definition.id,
              attemptId,
              workerId: worker.id,
              workerVersion: worker.version,
            },
            charges,
          );
          throw stageRunnerError(
            StageRunnerErrorCodes.WORKER_SPEND_UNAUTHORIZED,
            `Stage "${definition.id}" declared Worker "${worker.id}" free and it reported a ` +
              "charge. The charge is recorded, and no grant is credited with authorizing it — " +
              "attaching one after the fact would invent an approval nobody gave (§13.2, §19.3).",
            {
              category: "policy",
              retryable: false,
              details: { stageId: definition.id, workerId: worker.id },
            },
          );
        }
        return result as WorkerResult<WO>;
      },
      runAgent: async (request: StageAgentRequest) => {
        // Everything below runs before the backend is reached. A refusal after the provider call
        // is not a refusal, and an agent execution is paid by default rather than by exception.
        const dispatcher = this.#options.agentDispatch;
        if (dispatcher === undefined) {
          throw stageRunnerError(
            StageRunnerErrorCodes.AGENT_DISPATCH_UNAVAILABLE,
            `Stage "${definition.id}" called runAgent and no agent dispatcher is wired. A ` +
              "configured backend is a capability source, not a dispatcher: something has to own " +
              "grant resolution, reservation and attribution, and refusing beats dispatching " +
              "with none of them (§10, §13.2).",
            {
              category: "validation",
              retryable: false,
              details: { runId, stageId: definition.id },
            },
          );
        }

        const declaration = (request as { spend?: { expectation?: { kind?: string } } }).spend;
        const expectation = declaration?.expectation;
        if (
          expectation?.kind !== "free" &&
          expectation?.kind !== "estimated" &&
          expectation?.kind !== "unestimated"
        ) {
          throw stageRunnerError(
            StageRunnerErrorCodes.WORKER_SPEND_UNDECLARED,
            `Stage "${definition.id}" called runAgent without declaring what the execution is ` +
              'expected to cost. State `spend: { expectation: { kind: "free" } }`, or an estimate ' +
              "with the operation and billing-effect identity that authorize it (§13.2, §19.3).",
            {
              category: "validation",
              retryable: false,
              details: { runId, stageId: definition.id },
            },
          );
        }
        const paidDeclaration = declaration as unknown as {
          operation?: string;
          billingEffectKey?: string;
        };

        // Runtime-owned, all three. A Stage that could set these would choose its own ceiling or
        // correlate its execution with another attempt.
        const executionId = this.#options.newEventId();
        const onAgentAbort = () => {
          // Fire and forget: the attempt is already unwinding, and a backend that cannot observe
          // the signal still needs telling. Cancelling never releases the reservation — a
          // cancelled request may already have been billed (§19.3).
          void dispatcher.cancel?.(executionId);
        };
        controller.signal.addEventListener("abort", onAgentAbort, { once: true });

        let dispatched: StageAgentDispatchResult;
        try {
          dispatched = await dispatcher.execute({
            request: request.request,
            executionId,
            signal: controller.signal,
            runId,
            episodeId: manifest.episode.episodeId,
            stageId: definition.id,
            attemptId,
            actor: this.#options.actor,
            ...(paidDeclaration.operation === undefined
              ? {}
              : { operation: paidDeclaration.operation }),
            ...(paidDeclaration.billingEffectKey === undefined
              ? {}
              : { billingEffectKey: paidDeclaration.billingEffectKey }),
            expectation: expectation as CostExpectation,
          });
        } finally {
          controller.signal.removeEventListener("abort", onAgentAbort);
        }

        const result = dispatched.result;
        const paused = result.session !== undefined;
        notes.push(
          `agent execution ${executionId} dispatched` +
            (dispatched.billingUnconfirmed ? " (billing unresolved)" : "") +
            (paused ? " (paused)" : ""),
        );

        // Unresolved billing is checked **first**, and carries the pause with it rather than
        // yielding to it. It is the fact that governs what a caller may do next — the effect is
        // non-retryable — and splitting the two into separate arms would let one disappear
        // whenever both are true.
        if (dispatched.billingUnconfirmed) {
          return {
            kind: "billing_unresolved" as const,
            paused,
            explanation:
              `Execution ${executionId} recorded a charge whose amount or billing status could ` +
              "not be confirmed, so its reservation stays unresolved and the effect is not " +
              "retryable: an unconfirmed charge may have landed, and re-running would spend " +
              "again on the assumption it did not (§19.3)." +
              (paused ? " The backend also paused and offered a session Aldus cannot resume." : ""),
            result,
          };
        }

        // A pause is its own outcome, read from the backend's own session offer but **surfaced as
        // a distinct arm** rather than left as a nullable field on a result whose `ok` a caller
        // would otherwise read as completion. V1 cannot resume, so saying so is the honest answer.
        if (paused) {
          return {
            kind: "paused_unsupported" as const,
            explanation:
              `The backend paused execution ${executionId} and offered a session to resume from. ` +
              "Aldus does not resume agent sessions: a paused session spans attempts, and a " +
              "reservation outliving the attempt that created it is a lifecycle state the spend " +
              "protocol does not have (ADR-0047). Whatever was billed before the pause is " +
              "already recorded.",
            result,
          };
        }
        return { kind: "completed" as const, result };
      },
      registerOutput: async (registration: StageOutputRegistration) => {
        const recorder = this.#options.artifacts;
        if (recorder === undefined) {
          throw stageRunnerError(
            StageRunnerErrorCodes.ARTIFACT_RECORDER_UNAVAILABLE,
            `Stage "${definition.id}" called registerOutput, but no artifact recorder is wired. ` +
              "Supply one when constructing the runner (contract §8, ADR-0027).",
            {
              category: "validation",
              retryable: false,
              details: { runId, stageId: definition.id, path: registration.path },
            },
          );
        }
        // Provenance comes from the attempt, never from the stage: §8.1 requires an artifact to
        // record which stage, run, code revision, and configuration produced it, and the runner
        // is the only party that knows all four for certain.
        const artifact = await recorder.register({
          ...registration,
          producerRunId: runId,
          producerStageId: definition.id,
          ...(manifest.codeRevision === undefined ? {} : { codeRevision: manifest.codeRevision }),
          configHash: input.configurationHash,
          configuration: metadata.configuration,
        });
        assertValid("ArtifactRef", artifact);
        outputs.push(artifact);
        return artifact;
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
    // A function rather than a snapshot: notes are appended right up to the point a stage settles,
    // and a value captured earlier silently drops whatever came after it. An advisory evaluation
    // finding lost that way would leave a green record that looks like semantic correctness, which
    // is the one thing §12 says a green record never means.
    // Late-bound with the notes, for the same reason and from the same values — so the record and
    // its rendering cannot disagree about what the evaluator said.
    let observations: EvaluationObservation[] | undefined;
    let evaluationEvidence:
      { enumeratedFindings: number; reports: number; defectCountMeasurable: boolean } | undefined;
    let blockingFindingClasses: string[] | undefined;
    const withNotes = (): AttemptMetadata => ({
      ...metadata,
      ...(notes.length > 0 ? { notes: [...notes] } : {}),
      // Redacted like everything else that reaches a record: an evaluator's message is
      // operator-facing text over the adopter's own subject (§19.2).
      ...(observations === undefined
        ? {}
        : { observations: redact(observations.map((o) => ({ ...o }))) as EvaluationObservation[] }),
      ...(evaluationEvidence === undefined ? {} : { evaluationEvidence }),
      ...(blockingFindingClasses === undefined ? {} : { blockingFindingClasses }),
      // Late-bound like the notes, and for the same reason: invocations accumulate right up to the
      // point a stage settles, and a value captured earlier silently drops whatever came after it.
      ...(workerInvocations.length > 0
        ? {
            workerInvocations: redact(
              workerInvocations.map((entry) => ({ ...entry })),
            ) as typeof workerInvocations,
          }
        : {}),
    });

    if (controller.signal.aborted) {
      return this.#terminal(manifest, definition, settled, withNotes(), {
        status: "cancelled",
        invocationKey,
        error: cancellationError(definition.id, ordinal),
      });
    }

    if (thrown !== undefined) {
      if (isGateRequiredSignal(thrown)) {
        // **An escalation that cannot be decided is worse than no escalation**, because it looks
        // like the loop stopped safely. `thrown.gateId` was taken as given: nothing checked it
        // against a registered gate or the stage's declared gates, so a typo or a stale name
        // recorded a permanent, silent `waiting_for_gate` that no `approve` could ever clear.
        //
        // This matters more than a typo usually would because every automatic escalation path
        // terminates here — bound exhaustion, oscillation, an unknown finding class, an ambiguous
        // verdict (#220 criteria 5 and 7). A controller that escalates safely into an
        // undecidable wait has not escalated.
        //
        // Validation is a port rather than a lookup: the authority is the workflow graph, which
        // lives in the services layer and overrides a definition per workflow (ADR-0021). Where
        // no validator is supplied the declared gates are the fallback, and where the stage
        // declares none the id cannot be checked here at all — that limit is real and is why the
        // refusal below says which check it applied.
        if (!this.#canWaitOn(thrown.gateId, definition)) {
          return this.#undecidableGate(
            manifest,
            definition,
            settled,
            withNotes(),
            invocationKey,
            thrown.gateId,
          );
        }
        return this.#terminal(
          manifest,
          definition,
          settled,
          {
            ...withNotes(),
            gateId: thrown.gateId,
            subjectHashes: [...thrown.subjectHashes],
          },
          {
            status: "waiting_for_gate",
            invocationKey,
            gateId: thrown.gateId,
          },
        );
      }
      return this.#terminal(manifest, definition, settled, withNotes(), {
        status: "failed",
        invocationKey,
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
      // Both paths, because a stage may **return** a gate requirement as well as throw one, and
      // fixing only the thrown one would leave the commoner shape unchecked.
      if (!this.#canWaitOn(outcome.gateId, definition)) {
        return this.#undecidableGate(
          manifest,
          definition,
          settled,
          withNotes(),
          invocationKey,
          outcome.gateId,
        );
      }
      return this.#terminal(
        manifest,
        definition,
        settled,
        {
          ...withNotes(),
          gateId: outcome.gateId,
          ...(outcome.subjectHashes !== undefined
            ? { subjectHashes: [...outcome.subjectHashes] }
            : {}),
        },
        {
          status: "waiting_for_gate",
          invocationKey,
          gateId: outcome.gateId,
        },
      );
    }

    // An evaluator that ran and found something. Whether any of it stops work is decided by the
    // channels the stage declared, never by the stage itself: a finding cannot be promoted past
    // the enforcement its class was declared under, which is what makes declaring it worth
    // anything (§12.1, ADR pending on #115).
    if (outcome.kind === "evaluated") {
      const channels = definition.evaluation?.channels ?? [];
      const blocking: EvaluationObservation[] = [];
      for (const finding of outcome.observations) {
        const channel = channels.find((entry) => entry.findingClass === finding.findingClass);
        if (channel === undefined) {
          // Refused rather than defaulted. A finding whose class the stage never declared would
          // otherwise have its enforcement decided by a default nobody wrote down, and the safe
          // default and the useful one point in opposite directions.
          return this.#terminal(manifest, definition, settled, withNotes(), {
            status: "failed",
            invocationKey,
            error: redactError(
              toStructuredError(
                stageRunnerError(
                  StageRunnerErrorCodes.STAGE_EVALUATION_INVALID,
                  `Stage "${definition.id}" reported a "${finding.findingClass}" finding and ` +
                    "declares no channel for that class, so nothing says whether it stops work " +
                    "(contract §12).",
                  {
                    category: "validation",
                    retryable: false,
                    details: { stageId: definition.id, findingClass: finding.findingClass },
                  },
                ),
              ),
            ),
          });
        }
        // The evidence form is declared, not chosen per result (#140). A stage that could decide
        // per observation whether its output is countable could make a defect rate mean whatever
        // this run needed it to mean — the same reason enforcement is declared rather than set on
        // the way past.
        const expectedKind = channel.evidenceKind === "aggregate_reports" ? "report" : "finding";
        if (finding.kind !== expectedKind) {
          return this.#terminal(manifest, definition, settled, withNotes(), {
            status: "failed",
            invocationKey,
            error: redactError(
              toStructuredError(
                stageRunnerError(
                  StageRunnerErrorCodes.STAGE_EVALUATION_INVALID,
                  `Stage "${definition.id}" emitted a "${finding.kind}" on channel ` +
                    `"${finding.findingClass}", which declares "${channel.evidenceKind}". An ` +
                    "enumerated finding counts as one defect and a report counts as none, so " +
                    "emitting the other form would make a defect count mean something the " +
                    "declaration did not say (contract §12).",
                  {
                    category: "validation",
                    retryable: false,
                    details: {
                      stageId: definition.id,
                      findingClass: finding.findingClass,
                      declared: channel.evidenceKind,
                      emitted: finding.kind,
                    },
                  },
                ),
              ),
            ),
          });
        }
        // Both forms trigger the channel's declared enforcement. Countability and blocking are
        // separate questions: a report that cannot be counted can still stop work.
        if (channel.enforcement === "blocking") blocking.push(finding);
      }

      // Recorded either way — an advisory finding that vanished would make a green result look
      // like semantic correctness, which §12 forbids.
      //
      // **Structurally, and rendered as notes second.** These previously survived only as the
      // formatted strings below: `locator` and `category` were dropped, and so was the
      // `finding`/`report` discriminant, so `countEvaluationEvidence` could not be recomputed from
      // the record and `defectCountMeasurable` was unrecoverable rather than false. A consumer
      // then has one route to a verdict — a regex over prose the runtime formatted for a human —
      // which is the move `AggregateReport`'s own docstring rejects for another program's output.
      // Reported by the first adopter, who wanted the record before they wanted the loop.
      observations = [...outcome.observations];
      const evidence = countEvaluationEvidence(outcome.observations);
      evaluationEvidence = { ...evidence };
      blockingFindingClasses = [...new Set(blocking.map((finding) => finding.findingClass))];

      for (const observation of outcome.observations) {
        // The kind is written into the note, because a note reading only "warning: …" is exactly
        // the record that gets counted as one defect later (#140).
        notes.push(`${observation.kind}/${observation.findingClass}: ${observation.message}`);
      }
      if (!evidence.defectCountMeasurable) {
        notes.push(
          `evaluation evidence: ${evidence.enumeratedFindings} enumerated finding(s) and ` +
            `${evidence.reports} report(s); a defect count over this evidence is not measurable, ` +
            "because a report states that an evaluator had something to say and not how much.",
        );
      }

      if (blocking.length > 0) {
        return this.#terminal(manifest, definition, settled, withNotes(), {
          status: "failed",
          invocationKey,
          error: redactError(
            toStructuredError(
              stageRunnerError(
                StageRunnerErrorCodes.STAGE_EVALUATION_BLOCKED,
                `Stage "${definition.id}" has ${blocking.length} blocking observation(s). This is ` +
                  "the evaluator working, not the evaluator failing — the findings are recorded " +
                  "and the stage stopped because their class is declared blocking (§12).",
                {
                  category: "policy",
                  retryable: false,
                  details: { stageId: definition.id, blockingFindings: blocking.length },
                },
              ),
            ),
          ),
        });
      }
    }

    const parsedOutput = definition.outputSchema.safeParse(outcome.output);
    if (!parsedOutput.success) {
      // §11: a stage must "produce declared outputs or a structured failure". A value that is
      // neither is the stage breaking its own contract, so this is a stage failure rather than a
      // runner crash — and it is recorded as one, with the outputs it did produce.
      return this.#terminal(manifest, definition, settled, withNotes(), {
        status: "failed",
        invocationKey,
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

    // §11's "produce declared outputs or a structured failure", for the half that lives in the
    // registry rather than the return value (ADR-0040). Checked here, on the way to `succeeded`,
    // and deliberately not on the failed, cancelled or gate-halted paths: a stage that stopped
    // halfway owes nothing, and demanding a complete artifact set from an incomplete attempt would
    // turn every ordinary failure into two.
    const breaches = checkArtifactContract(input.expectedArtifacts, settled.outputArtifacts);
    if (breaches.length > 0) {
      // The artifacts already registered stay on the attempt. They are evidence of how far the
      // stage got, and the diagnosis this failure exists to enable needs them.
      return this.#terminal(manifest, definition, settled, withNotes(), {
        status: "failed",
        invocationKey,
        error: {
          code: StageRunnerErrorCodes.STAGE_ARTIFACT_CONTRACT_UNMET,
          category: "validation",
          message:
            `Stage "${definition.id}" produced a value but did not satisfy the artifact contract ` +
            `resolved for this invocation (contract §8.1, §11): ` +
            breaches
              .map((breach) =>
                breach.reason === "undeclared"
                  ? `registered ${breach.registered} artifact(s) of undeclared kind "${breach.kind}"`
                  : `kind "${breach.kind}" registered ${breach.registered} time(s), expected ` +
                    `at least ${breach.expected?.minCount ?? 0}` +
                    (breach.expected?.maxCount === undefined
                      ? ""
                      : ` and at most ${breach.expected.maxCount}`),
              )
              .join("; ") +
            ". Suspect the declaration before the stage: a kind that was never going to be " +
            "registered is the likelier cause than a stage that stopped registering one.",
          retryable: false,
          details: {
            stageId: definition.id,
            stageVersion: definition.version,
            breaches: breaches.map((breach) => ({ ...breach })),
          },
        },
      });
    }

    return this.#terminal<O>(manifest, definition, settled, withNotes(), {
      status: "succeeded",
      invocationKey,
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
      invocationKey: string;
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

    // **The caller is told what was written down, not what was attempted** (#254). When the full
    // record is refused and a reduced one takes its place, the error the durable record carries
    // is the reduced one — so returning `settle.error` here would hand `run`'s caller, and every
    // consumer above it, an error the Run record does not contain and which is in general not
    // even `structuredErrorSchema`-valid (the LONG_CODE case is exactly that). `#record` reports
    // the error it persisted; where nothing was reduced it is `settle.error` unchanged.
    const recorded = await this.#record(manifest, definition, final, metadata, {
      action: actionFor(settle.status),
      previousState: "running",
      invocationKey: settle.invocationKey,
      ...(settle.error !== undefined ? { error: settle.error } : {}),
    });

    return {
      status: settle.status,
      attemptId: final.attemptId,
      attempt: final.attempt,
      outputArtifacts: [...final.outputArtifacts],
      ...(settle.output !== undefined ? { output: settle.output } : {}),
      ...(settle.gateId !== undefined ? { gateId: settle.gateId } : {}),
      ...(recorded !== undefined ? { error: recorded } : {}),
    };
  }

  /**
   * Append the lifecycle event, then update the cache — in that order, under the Run lock.
   *
   * §6.4 requires every state mutation to emit an event, so the event is the write that must not
   * be lost. A crash between the two leaves the log complete and the cache one event behind, which
   * `reconcileStageState` repairs. The opposite order would leave a state change with no audit
   * record, which nothing could repair because nothing would know it happened.
   *
   * Returns the error the durable record actually carries — `options.error` unchanged on the
   * ordinary path, and the reduced one when the full record was refused and a degraded record
   * took its place. `#terminal` returns that to the caller, so what a consumer branches on and
   * what the event log holds are the same value rather than two that diverge silently.
   */
  async #record(
    manifest: RunManifest,
    definition: StageDefinition<never, unknown> | StageDefinition<unknown, unknown>,
    attempt: StageAttempt,
    metadata: AttemptMetadata,
    options: {
      action: string;
      previousState: StageStatus | undefined;
      invocationKey: string;
      error?: StructuredError;
    },
  ): Promise<StructuredError | undefined> {
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
      invocationKey: options.invocationKey,
      ...(options.error !== undefined ? { error: options.error } : {}),
      details: details as unknown as Record<string, unknown>,
    };

    try {
      await this.#write(runId, event);
      return options.error;
    } catch (thrown) {
      // **A failure to report a failure must not discard the failure** (#254). The event carries
      // detail the stage produced — a message, a code, a `details` bag — and the runner did not
      // size any of it. When that detail is what the schema rejects, the write that reports the
      // outcome is the one that fails, and the attempt is left reading `running`: from the Run
      // record alone, indistinguishable from a stage still working, with its cost already
      // written down.
      //
      // Only for a terminal state, and only for a validation refusal. A lock timeout or a full
      // disk is not repaired by writing less, and a `running` event that will not validate has no
      // outcome worth preserving — both of those propagate unchanged.
      const degraded = this.#degrade(event, attempt, details, thrown);
      if (degraded === undefined) throw thrown;
      try {
        await this.#write(runId, degraded);
      } catch {
        // The reduced record failed too, so nothing here is recoverable. The original refusal is
        // the one that explains why, and swallowing it for this one would report the symptom.
        throw thrown;
      }
      return degraded.error;
    }
  }

  /**
   * Append the event, then update the cache — in that order, under the stage-state lock.
   *
   * A resource of its own, not the Run lock. `FileEventStore.append` takes the Run lock itself
   * (ADR-0005 assigns the sequence under it), and a file lock is not re-entrant — nesting the
   * same resource deadlocks until the acquisition deadline. This lock serialises cache writers
   * among themselves while `append` keeps serialising the log.
   */
  async #write(runId: string, event: AldusEvent): Promise<void> {
    await this.#options.locks.withLock(stageStateLockResource(runId), async () => {
      const stored = await this.#options.events.append(runId, event);
      const path = this.#options.stageStatePath(runId);
      const current = await readStageState(path).catch(() => emptyStageState());
      await writeStageState(path, applyLifecycleEvent(current, stored));
    });
  }

  /**
   * The reduced event to write when the full one will not validate, or `undefined` to give up.
   *
   * Reduces exactly what the runner did not size: the attempt's `error` becomes a minimal one
   * saying that the record was reduced and how many paths the refusal named. Everything else — the attempt's identity, its terminal status, its
   * actor, its artifacts, its timestamps, its metadata — is carried over unchanged. Those were
   * validated where they were produced, and dropping them to be safe would trade the defect this
   * repairs for a loss of the execution record it is meant to preserve.
   *
   * The reduced error is written into the embedded attempt as well as onto the event. `details`
   * is an unvalidated bag, so the oversized copy inside it would survive the append — and then
   * fail `StageExecution` validation on the next read of the stage-state cache, moving the
   * refusal one layer along instead of removing it.
   */
  #degrade(
    event: AldusEvent,
    attempt: StageAttempt,
    details: StageLifecycleDetails,
    thrown: unknown,
  ): AldusEvent | undefined {
    if (attempt.status !== "failed" && attempt.status !== "cancelled") return undefined;

    // Duck-typed through `toStructuredError` rather than `instanceof`: the refusal is raised in
    // another package, and a category is a value the contract defines (§19.1) where a class
    // identity is a fact about module resolution.
    const refusal = toStructuredError(thrown, {
      code: StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED,
      category: "internal",
    });
    if (refusal.category !== "validation") return undefined;

    const error = degradedError(attempt, refusal);
    const reduced: StageAttempt = { ...attempt, error };
    const reducedDetails: StageLifecycleDetails = { ...details, attempt: reduced };

    return {
      ...event,
      error,
      details: reducedDetails as unknown as Record<string, unknown>,
    };
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
  // Truncation comes after redaction, not before: a redaction substitutes a placeholder for a
  // secret and can lengthen the message it rewrites, so a value truncated first could come back
  // over the cap. Both are construction-time constraints on a durable record (§19.1, §19.2).
  return truncateErrorMessages(redact(error) as unknown as StructuredError);
}

/**
 * The minimal failure written in place of one the schema refused (#254).
 *
 * Says three things and no more: that the attempt failed, what it said before the refusal, and
 * how many paths the refusal named. **Not which paths** — see `withheldPathCount` below.
 */
function degradedError(attempt: StageAttempt, refusal: StructuredError): StructuredError {
  const original = attempt.error;
  const withheld = validationIssuePaths(refusal).length;
  const where =
    withheld === 0 ? "" : ` ${withheld} rejected path${withheld === 1 ? "" : "s"} withheld.`;
  return {
    code: StageRunnerErrorCodes.STAGE_TERMINAL_RECORD_DEGRADED,
    category: original?.category ?? "internal",
    message: truncateErrorMessage(
      `Attempt ${attempt.attempt} of stage "${attempt.stageId}" ended as "${attempt.status}", ` +
        "and its full record could not be written: " +
        refusal.message +
        where +
        (original === undefined
          ? ""
          : ` The attempt reported code "${truncateCode(original.code)}": ${original.message}`),
    ),
    retryable: original?.retryable ?? false,
    details: {
      degraded: true,
      ...(original !== undefined ? { originalCode: truncateCode(original.code) } : {}),
      refusalCode: refusal.code,
      ...(withheld > 0 ? { withheldPathCount: withheld } : {}),
    },
  };
}

/**
 * How many failing paths a validation refusal reported, where it carries them in the documented
 * shape.
 *
 * Only the count leaves this function, and the paths themselves are read solely to produce it
 * (#255). The runner cannot establish where a path came from: `StageRunnerOptions.events` is any
 * `EventStore` (`packages/aldus-file-store/src/ports.ts:115`), whose `append` promises to store
 * an `AldusEvent` and promises nothing about the shape, the vocabulary, or the provenance of the
 * error it rejects with. So a conforming store may reject with `details.issues[].path` taken from
 * a key the *caller* supplied — a stage's `error.details` bag is caller-keyed and unvalidated —
 * and any test that distinguishes a schema field from such a key by its shape can be defeated by
 * naming the key after a field.
 *
 * An earlier version of this file did exactly that: it reasoned from Core's own schema topology
 * that no reachable `z.record` could raise an issue, and kept a segment-shape guard behind that
 * reasoning. Both halves are true of Core's `eventSchema` and neither is a fact about the port,
 * so the argument proved nothing about the object actually validating here.
 *
 * The fail-safe reading is the only one the port supports: no rejected path is persisted or
 * quoted, and the count is what tells a reader the list is absent because it was withheld rather
 * than because the refusal was empty.
 */
function validationIssuePaths(refusal: StructuredError): string[] {
  const issues = refusal.details?.["issues"];
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) =>
    typeof issue === "object" &&
    issue !== null &&
    typeof (issue as { path?: unknown }).path === "string"
      ? [(issue as { path: string }).path]
      : [],
  );
}

/**
 * Fit a foreign code into the schema's own bound (§19.1).
 *
 * Only ever applied to a code being quoted *inside* a degraded record, never to one a consumer
 * will branch on — a degraded record that reproduced the refusal it exists to survive would be
 * worse than none.
 */
function truncateCode(code: string): string {
  return code.length <= MAX_ERROR_CODE_LENGTH
    ? code
    : `${code.slice(0, MAX_ERROR_CODE_LENGTH - 1)}…`;
}

/** Gate a stage execution is parked on, if any. */
function gateIdOf(stored: StoredStageExecution): string | undefined {
  const latest = stored.execution.attempts.at(-1);
  return latest === undefined ? undefined : stored.metadata[latest.attemptId]?.gateId;
}
