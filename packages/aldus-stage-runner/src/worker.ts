/**
 * The Worker seam (contract §3.2, §4.1; ADR-0035).
 *
 * §3.2 is design principle #2 — a task that can be made deterministic, repeatable and testable
 * SHOULD be a Worker rather than an Agent — and §4.1 makes the interface Core's to own. It did not
 * exist until #111, so the contract told adopters to prefer the seam that was missing.
 *
 * A Worker performs one declared operation. It does **not** own validation, gates, retry,
 * idempotency, cost authorization, artifact provenance, or attempt state: those stay with the
 * Stage, and a Worker that acquired them would be a second workflow abstraction competing with the
 * first (ADR-0035).
 */

import type { CostObservation, Money } from "@aldus-runtime/core";

import { StageRunnerErrorCodes, stageRunnerError } from "./errors.js";

/** What a Worker can do (contract §10, §11). */
export interface WorkerCapabilities {
  /** Capability names offered. Open strings, matched exactly — Core names none (§4.2). */
  offers: readonly string[];
  /** Ceiling on a single execution, if the Worker imposes one. */
  maxDurationMs?: number;
  /**
   * Whether this exact version reports what it was actually charged (§19.3; #107).
   *
   * Declared per version because a capability is a fact about the code that ran. A Worker that
   * reports actual cost today says nothing about the request an earlier version made, and reading
   * today's declaration back onto it would claim a protection that was not in force.
   */
  reportsActualCost?: boolean;
  /** Whether this exact version reports an estimate before or alongside the charge (§19.3). */
  reportsEstimatedCost?: boolean;
  /**
   * Whether this exact version **enforces** a spend ceiling it is handed (§13.2).
   *
   * A ceiling is passed only when this is true. Passing one to a Worker that ignores it would
   * record a protection that does not exist (ADR-0030) — and the number itself always comes from
   * the grant, never from the Worker, because a spender must not choose its own limit.
   */
  enforcesSpendCeiling?: boolean;
  /**
   * Whether this exact version can be asked, later, what a past request was charged (§19.3).
   *
   * Mirrors a billing capability rather than granting one: it tells an operator whether an unknown
   * charge is answerable at the source, which is what a reconciliation needs to know before it
   * starts.
   */
  supportsCostReconciliation?: boolean;
}

/**
 * One invocation of a Worker, as the runtime hands it over.
 *
 * Every field is supplied by the runtime from the attempt in progress. A Worker cannot assert its
 * own run, stage or attempt identity, which is what keeps §20's trace attributable to what
 * executed rather than to what a Worker claimed about itself.
 */
export interface WorkerRequest<I = unknown> {
  /** The operation's input, already validated by the Stage (§11). */
  input: I;
  /** Run this invocation belongs to (§6.2). */
  runId: string;
  /** Canonical Episode identity (§6.1). */
  episodeId: string;
  /** Stage invoking this Worker (§11). */
  stageId: string;
  /** Attempt this invocation belongs to (§6.3). */
  attemptId: string;
  /**
   * Digest of the **Stage's** configuration, for the trace (§20).
   *
   * Not the Worker's own. A Worker whose settings live inside its implementation — thresholds, a
   * window size — has those covered by {@link Worker.version}, which is why versions resolve
   * exactly. Do not hash in-implementation configuration into anything: bump the version instead,
   * so a completed Run names the implementation that produced it.
   */
  configurationHash: string;
  /**
   * Digests of the artifacts the Stage declared as inputs (§8.1, §19.1).
   *
   * Present because {@link WorkerRequest.idempotencyKey} otherwise claims more than it knows. A
   * Worker that takes paths — and §3.2's first example, FFmpeg rendering, has no by-value form for
   * a 60 GiB working set — can be handed the same key and the same configuration while the bytes
   * behind those paths have changed. §8.1's rule that a path is not identity applies here too, and
   * this is the field that keeps it true at the boundary.
   *
   * Empty when the Stage declared no input artifacts.
   */
  inputHashes: readonly string[];
  /**
   * What the destination deduplicates this effect on (§19.1; #149).
   *
   * **Optional, and absent means no key exists** — never a substitute. It carried
   * `effectKey ?? invocationKey`, which handed a fingerprint of declared work to an external
   * system as a deduplication credential, the one thing ADR-0036 forbids in as many words. Worse
   * than imprecise: for a Stage with an empty input schema and no declared input artifacts that
   * fingerprint is a **constant**, so a platform deduplicating on it would treat every episode's
   * first request as a repeat of the first episode's, forever.
   *
   * A Worker author checking whether this is populated used to get `true` in both the real case
   * and the useless one, with no way to tell them apart. Absent is the honest answer, and it means
   * this operation must not be deduplicated on anything supplied here.
   *
   * Never reconstruct one from `runId`, `attemptId`, `configurationHash` or an empty
   * {@link WorkerRequest.inputHashes}: each is available and none of them identifies the effect.
   */
  idempotencyKey?: string;
  /**
   * Cancellation (§19.1).
   *
   * The primary mechanism, not a courtesy. A Worker performing long or external work SHOULD
   * observe this rather than rely on {@link Worker.cancel}, which exists only for executions that
   * cannot see a signal at all.
   */
  /**
   * The ceiling this invocation may not exceed, when one applies (§13.2; #107).
   *
   * Present **only** when the grant supplied a per-request limit and this exact Worker version
   * declared `enforcesSpendCeiling`. Absent otherwise — a Worker that ignores the field would
   * otherwise be handed a number that reads, in the trace, like a protection that was applied.
   *
   * The value is the grant's, never the Worker's own claim: a spender must not choose its limit.
   */
  maxSpend?: Money;
  signal: AbortSignal;
}

/** What a Worker reports back. */
export interface WorkerResult<O = unknown> {
  /** The operation's output, validated by the Stage on return (§11). */
  output: O;
  /**
   * Anything the Worker wants in the production trace beyond its output (§20).
   *
   * Redacted before it reaches a durable record (§19.2), like any other adopter-supplied value.
   */
  details?: Readonly<Record<string, unknown>>;
  /**
   * What this invocation was charged (contract §19.3; #107).
   *
   * The same observation contract an `AgentBackend` reports, deliberately — §3.2's Workers
   * include TTS invocation and rendering, which are paid, and a Worker that knows what it spent
   * must be able to say so through the same channel rather than a parallel one.
   *
   * Billing facts only; the Runtime supplies the attribution.
   */
  costs?: readonly CostObservation[];
}

/**
 * An adopter- or provider-supplied implementation of a declared operation (§3.2, §4.3).
 *
 * Deliberately narrower than `AgentBackend`. There is no `resume`, and the reason is **not** that
 * a Worker is cheap or safe to re-run — §3.2's own examples include TTS invocation and rendering,
 * which are paid, sometimes nondeterministic, and externally visible. Recovery belongs to the
 * Stage's idempotency, artifact and ledger model, which knows what was produced and what was
 * charged.
 *
 * > Aldus must never infer that a Worker is automatically rerunnable merely because it is called
 * > a Worker.
 */
export interface Worker<I = unknown, O = unknown> {
  /** Identity. An open string — Core names no Worker (§4.2). */
  id: string;
  /**
   * Version of this implementation.
   *
   * Resolved exactly, never by "latest". §20 requires a completed Run to stay explicable, and a
   * Run that invoked `1` must remain readable after `2` is registered.
   */
  version: string;
  /** What this Worker offers, checked before any side effect. */
  capabilities(): Promise<WorkerCapabilities>;
  /** Perform the operation. */
  execute(request: WorkerRequest<I>): Promise<WorkerResult<O>>;
  /**
   * Cancel an external execution that cannot observe {@link WorkerRequest.signal}.
   *
   * Optional and deliberately narrow: a remote job with its own lifecycle. A Worker running in
   * this process should observe the signal instead.
   *
   * Keyed by attempt, which is the thing in flight. Note the limit deliberately: two executions of
   * one attempt cannot be told apart here, so a retry overlapping a slow cancel is ambiguous. That
   * is accepted for V1 because the runner does not overlap attempts, and it is recorded rather
   * than left to be discovered by the first adapter that does.
   */
  cancel?(attemptId: string): Promise<void>;
}

/** A Worker and the version it was registered under. */
export interface WorkerRef {
  id: string;
  version: string;
}

/**
 * Workers available to a composition, resolved by exact `id` and `version` (ADR-0035).
 *
 * There is no implicit latest-version selection, for the reason `StageRegistry` has none: a Run
 * that executed one version must stay readable after another is registered, and a registry that
 * silently upgraded would make §20's trace describe something that did not run.
 */
export class WorkerRegistry {
  readonly #workers = new Map<string, Worker>();

  /** Register a Worker. Rebinding an id and version to a different object refuses. */
  register(worker: Worker): void {
    const key = keyFor(worker.id, worker.version);
    const existing = this.#workers.get(key);
    if (existing !== undefined && existing !== worker) {
      throw stageRunnerError(
        StageRunnerErrorCodes.WORKER_ALREADY_REGISTERED,
        `A different Worker is already registered as "${worker.id}" version "${worker.version}". ` +
          "Rebinding a version would make a completed Run's trace describe an implementation " +
          "that did not run it (contract §20).",
        {
          category: "conflict",
          retryable: false,
          details: { workerId: worker.id, version: worker.version },
        },
      );
    }
    this.#workers.set(key, worker);
  }

  /** Every registered Worker, for reporting. */
  list(): readonly WorkerRef[] {
    return [...this.#workers.values()].map((worker) => ({
      id: worker.id,
      version: worker.version,
    }));
  }

  /** Resolve a Worker, or `undefined` when that exact pair is not registered. */
  find(id: string, version: string): Worker | undefined {
    return this.#workers.get(keyFor(id, version));
  }

  /**
   * Resolve a Worker or refuse.
   *
   * @throws {AldusError} `ALDUS_WORKER_NOT_REGISTERED`
   */
  require(id: string, version: string): Worker {
    const worker = this.find(id, version);
    if (worker !== undefined) return worker;
    const known = this.list()
      .filter((ref) => ref.id === id)
      .map((ref) => ref.version);
    throw stageRunnerError(
      StageRunnerErrorCodes.WORKER_NOT_REGISTERED,
      `No Worker "${id}" version "${version}" is registered` +
        (known.length > 0
          ? `. Registered versions of "${id}": ${known.join(", ")}. Versions resolve exactly — ` +
            "nothing selects a nearest or latest one (ADR-0035)."
          : ", and no version of it is."),
      { category: "not_found", retryable: false, details: { workerId: id, version } },
    );
  }
}

function keyFor(id: string, version: string): string {
  return `${id} ${version}`;
}

/**
 * Verify a Worker offers every capability an operation requires, before it runs (§10, §11).
 *
 * Fails closed. A Worker declaring no capabilities does not thereby satisfy a requirement — the
 * check refuses rather than passing because nothing objected, which is the one behaviour that
 * makes a capability check worth having (ADR-0030, ADR-0035).
 *
 * @throws {AldusError} `ALDUS_WORKER_CAPABILITY_UNAVAILABLE`, naming every missing capability at
 * once, so a misconfigured Worker takes one run to diagnose rather than several.
 */
export function assertWorkerCapabilities(
  capabilities: WorkerCapabilities,
  required: readonly string[],
  context: { stageId: string; workerId: string; workerVersion: string },
): void {
  const offered = new Set(capabilities.offers);
  const missing = required.filter((capability) => !offered.has(capability));
  if (missing.length === 0) return;
  throw stageRunnerError(
    StageRunnerErrorCodes.WORKER_CAPABILITY_UNAVAILABLE,
    `Stage "${context.stageId}" requires ${missing.map((name) => `"${name}"`).join(", ")}, which ` +
      `Worker "${context.workerId}" version "${context.workerVersion}" does not offer. Checked ` +
      "before execution so a misconfiguration fails on the declaration rather than halfway " +
      "through a side effect (contract §19.1).",
    {
      category: "policy",
      retryable: false,
      details: {
        stageId: context.stageId,
        workerId: context.workerId,
        workerVersion: context.workerVersion,
        missing,
      },
    },
  );
}
