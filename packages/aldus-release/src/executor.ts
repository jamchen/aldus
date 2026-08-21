/**
 * Release execution, resumption, and reconciliation (architecture contract §17, §19.1).
 *
 * Three properties drive the design, and each rules out the obvious implementation:
 *
 * 1. **§17: every operation is independently idempotent and resumable.** So execution is never a
 *    transaction over a bundle. Each operation carries its own derived idempotency key and its
 *    own receipt, and a half-executed bundle is resumed by skipping what already succeeded.
 *
 * 2. **§17: pre-release hard gates and post-upload best-effort operations are distinguished.**
 *    The first failure among required operations stops the bundle — a failed media upload must
 *    not be followed by a visibility transition making nothing public. A best-effort failure is
 *    recorded and execution continues.
 *
 * 3. **§17: external state must be reconciled, not guessed.** A response lost after the
 *    destination accepted a request leaves local records saying nothing happened while something
 *    did. Retrying then publishes twice. So an operation whose outcome was recorded as `pending`
 *    is never retried; it is looked up, and if the destination cannot be queried the executor
 *    refuses rather than risking the duplicate.
 *
 * Nothing about a bundle's progress is stored beyond its receipts. State is derived on every
 * call, for the reason ADR-0009 derives gate state: a stored progress flag survives a crash that
 * the work it describes did not.
 */

import type { ActorRef, AldusEvent, ReleaseReceipt } from "@aldus-runtime/core";
import { SCHEMA_VERSION, newEventId, newReleaseId } from "@aldus-runtime/core";

import type { AdapterRegistry, AdapterOutcome, ReleaseRequest } from "./adapter.js";
import { assertBundleValid, deriveIdempotencyKey, type ReleaseBundle } from "./bundle.js";
import { ReleaseErrorCodes, releaseError } from "./errors.js";
import type { OperationCriticality, ReleaseOperation } from "./operation.js";
import { latestByKey, type ReleaseEventSink, type ReleaseReceiptStore } from "./ports.js";
import { permitAllAuthorizer, type ReleaseAuthorizer } from "./authorization.js";

/** Where one operation stands. */
export const OPERATION_STATES = [
  /** No receipt exists; it has not been attempted. */
  "not_started",
  /** Attempted, outcome unconfirmed. MUST be reconciled, never retried (contract §17). */
  "pending",
  /** Completed at the destination. */
  "succeeded",
  /** Attempted and rejected by the destination. */
  "failed",
  /** Deliberately not attempted — no authority, or nothing to do. */
  "skipped",
] as const;

/** @see OPERATION_STATES */
export type OperationState = (typeof OPERATION_STATES)[number];

/** The derived state of one operation in a bundle. */
export interface OperationStatus {
  operationId: string;
  kind: string;
  destination: string;
  /** Which §17 category the bundle placed it in. */
  criticality: OperationCriticality;
  idempotencyKey: string;
  state: OperationState;
  /** The receipt this state was derived from, if any. */
  receipt?: ReleaseReceipt;
}

/** Where a whole bundle stands (contract §19.1 "recovery from partial success"). */
export interface BundleStatus {
  bundleId: string;
  runId: string;
  /**
   * `succeeded` once every required operation has succeeded, whatever became of the best-effort
   * ones — that is what §17's distinction means in practice.
   */
  state: "not_started" | "in_progress" | "pending" | "failed" | "succeeded";
  operations: OperationStatus[];
  /** Operation ids that still need to run for the release to complete. */
  remaining: string[];
}

/** What reconciliation did about one operation. */
export interface ReconciliationFinding {
  operationId: string;
  idempotencyKey: string;
  action:
    /** A terminal receipt already existed; nothing to do. */
    | "already_recorded"
    /** The destination holds the result, so a missing or pending receipt was repaired. */
    | "repaired"
    /** The destination does not hold it, so the operation genuinely still needs to run. */
    | "confirmed_absent"
    /** The adapter cannot query the destination (contract §17 "where the platform allows it"). */
    | "unavailable"
    /**
     * The operation declares its effect safe to repeat, so it was not queried (#169).
     *
     * Deliberately its own action rather than folded into `confirmed_absent`. Nothing was
     * searched for, and saying it was absent would be the false statement this exists to stop.
     */
    | "not_reconciled_repeatable";
  explanation?: string;
}

/** What a reconciliation pass found. */
export interface ReconciliationReport {
  bundleId: string;
  runId: string;
  findings: ReconciliationFinding[];
  /** Receipts written to repair the local record. */
  repaired: ReleaseReceipt[];
}

/** The result of executing a bundle. */
export interface ReleaseOutcome {
  bundleId: string;
  runId: string;
  /**
   * `succeeded` when every required operation succeeded. A best-effort failure does not change
   * it (contract §17).
   */
  state: "succeeded" | "failed" | "pending";
  status: BundleStatus;
  /** Receipts written by this call, in order. */
  written: ReleaseReceipt[];
  /** Operator-facing notes: best-effort failures, skipped operations, reconciliation actions. */
  warnings: string[];
}

/**
 * Options for one reconciliation.
 *
 * Reconciliation writes receipts, which makes it a mutating action, and §19.2 requires a
 * mutating action to record actor identity. A repair attributed to no one is a record an
 * operator cannot question later, so the actor is required rather than defaulted to a system
 * placeholder.
 */
export interface ReconcileOptions {
  /** Who is reconciling (contract §19.2). */
  actor: ActorRef;
}

/** Options for one execution. */
export interface ExecuteOptions {
  /** Who is releasing (contract §19.2 "mutating actions MUST record actor identity"). */
  actor: ActorRef;
  /**
   * Reconcile before executing. Default `true`.
   *
   * Turning it off is what a blind retry looks like, and it is the unsafe path — it exists so
   * the tests can demonstrate the duplicate publish that reconciliation prevents.
   */
  reconcile?: boolean;
}

/** Wiring for a {@link ReleaseExecutor}. */
export interface ReleaseExecutorOptions {
  adapters: AdapterRegistry;
  receipts: ReleaseReceiptStore;
  events: ReleaseEventSink;
  /** Defaults to permitting everything, which is only correct when no operation needs authority. */
  authorizer?: ReleaseAuthorizer;
  /** Injected for deterministic tests. */
  now?: () => Date;
  /** Injected for deterministic tests. */
  nextReleaseId?: () => string;
  /** Injected for deterministic tests. */
  nextEventId?: () => string;
}

/** Executes release bundles, resumably. */
export class ReleaseExecutor {
  readonly #adapters: AdapterRegistry;
  readonly #receipts: ReleaseReceiptStore;
  readonly #events: ReleaseEventSink;
  readonly #authorizer: ReleaseAuthorizer;
  readonly #now: () => Date;
  readonly #nextReleaseId: () => string;
  readonly #nextEventId: () => string;

  constructor(options: ReleaseExecutorOptions) {
    this.#adapters = options.adapters;
    this.#receipts = options.receipts;
    this.#events = options.events;
    this.#authorizer = options.authorizer ?? permitAllAuthorizer();
    this.#now = options.now ?? (() => new Date());
    this.#nextReleaseId = options.nextReleaseId ?? newReleaseId;
    this.#nextEventId = options.nextEventId ?? newEventId;
  }

  /**
   * Derive where a bundle stands from its receipts (contract §19.1).
   *
   * Reads only; safe to call at any time, including on a bundle that has never run.
   */
  async status(bundle: ReleaseBundle): Promise<BundleStatus> {
    assertBundleValid(bundle);
    const latest = latestByKey(await this.#receipts.list(bundle.runId));
    const operations = this.#plan(bundle).map(({ operation, criticality, idempotencyKey }) =>
      toStatus(operation, criticality, idempotencyKey, latest.get(idempotencyKey)),
    );

    const required = operations.filter((entry) => entry.criticality === "required");
    const remaining = operations
      .filter((entry) => entry.state !== "succeeded" && entry.state !== "skipped")
      .map((entry) => entry.operationId);

    return {
      bundleId: bundle.bundleId,
      runId: bundle.runId,
      state: bundleState(required),
      operations,
      remaining,
    };
  }

  /**
   * Repair the local record against the destinations (contract §17).
   *
   * Only operations without a terminal local receipt are looked up: an operation already
   * recorded as succeeded or failed has an answer, and asking again would turn reconciliation
   * into polling.
   */
  async reconcile(bundle: ReleaseBundle, options: ReconcileOptions): Promise<ReconciliationReport> {
    assertBundleValid(bundle);
    const latest = latestByKey(await this.#receipts.list(bundle.runId));
    const findings: ReconciliationFinding[] = [];
    const repaired: ReleaseReceipt[] = [];

    for (const { operation, idempotencyKey } of this.#plan(bundle)) {
      const receipt = latest.get(idempotencyKey);
      if (receipt !== undefined && receipt.status !== "pending") {
        findings.push({
          operationId: operation.operationId,
          idempotencyKey,
          action: "already_recorded",
        });
        continue;
      }

      // Asked of nothing, because the answer would change nothing. A repeatable operation may be
      // performed again whatever the destination holds, so querying it buys no decision — and
      // where reconciliation runs before execution, as it does inside `execute`, a "not there"
      // reading can mean "the operation before it has not run yet" rather than "it did not
      // happen". An adapter forced to answer that question has to invent one (#169).
      if (operation.repeatable !== undefined) {
        findings.push({
          operationId: operation.operationId,
          idempotencyKey,
          action: "not_reconciled_repeatable",
          explanation:
            `"${operation.operationId}" declares its effect safe to repeat, so the destination ` +
            `was not queried: ${operation.repeatable.reason}`,
        });
        continue;
      }

      const adapter = this.#adapters.require(operation.destination);
      if (adapter.lookup === undefined) {
        findings.push({
          operationId: operation.operationId,
          idempotencyKey,
          action: "unavailable",
          explanation:
            `Destination "${operation.destination}" cannot be queried, so whether ` +
            `"${operation.operationId}" already happened is unknowable from here.`,
        });
        continue;
      }

      const request: ReleaseRequest = {
        operation,
        idempotencyKey,
        runId: bundle.runId,
      };
      const remote = await adapter.lookup(request);
      if (!remote.exists) {
        // Reserved to a `lookup` that actually returned `exists: false`. Every other reason an
        // operation might not have been found now has its own action, so this one means what it
        // says: a completed search established that the destination does not hold it (#169).
        findings.push({
          operationId: operation.operationId,
          idempotencyKey,
          action: "confirmed_absent",
        });
        continue;
      }

      const written = await this.#record(
        bundle,
        operation,
        idempotencyKey,
        {
          status: "succeeded",
          ...(remote.remoteId === undefined ? {} : { remoteId: remote.remoteId }),
          ...(remote.remoteUrl === undefined ? {} : { remoteUrl: remote.remoteUrl }),
        },
        options.actor,
      );
      repaired.push(written);
      findings.push({
        operationId: operation.operationId,
        idempotencyKey,
        action: "repaired",
        explanation:
          `The destination already holds "${operation.operationId}". The local record was ` +
          "repaired rather than the operation repeated.",
      });
    }

    return { bundleId: bundle.bundleId, runId: bundle.runId, findings, repaired };
  }

  /**
   * Execute a bundle, resuming whatever has already succeeded (contract §17, §19.1).
   *
   * Reconciles first by default, so the safe path is the one a caller gets without asking.
   */
  async execute(bundle: ReleaseBundle, options: ExecuteOptions): Promise<ReleaseOutcome> {
    assertBundleValid(bundle);
    const warnings: string[] = [];
    const written: ReleaseReceipt[] = [];

    if (options.reconcile !== false) {
      const report = await this.reconcile(bundle, { actor: options.actor });
      written.push(...report.repaired);
      for (const finding of report.findings) {
        if (finding.explanation !== undefined && finding.action !== "confirmed_absent") {
          warnings.push(finding.explanation);
        }
      }
    }

    let latest = latestByKey(await this.#receipts.list(bundle.runId));
    let halted = false;
    let haltState: "failed" | "pending" | undefined;

    for (const { operation, criticality, idempotencyKey } of this.#plan(bundle)) {
      // §17 calls the best-effort operations "post-upload": they run only once every required
      // one has succeeded. Attempting a notification about a release that failed would announce
      // something that does not exist.
      if (halted) {
        warnings.push(
          `"${operation.operationId}" was not attempted because a required operation did not ` +
            "succeed.",
        );
        continue;
      }

      const existing = latest.get(idempotencyKey);
      if (existing?.status === "succeeded" || existing?.status === "skipped") continue;

      // An operation whose outcome was never confirmed must not be retried (contract §17). If
      // reconciliation could have resolved it, it already ran above and this receipt would be
      // terminal; reaching here means the destination cannot be queried.
      //
      // Unless the operation says repeating it is safe, which is exactly the fact this refusal
      // needs and previously had no way to hear. Without it a best-effort tidy-up whose outcome
      // was once unconfirmed refused **every later release of that bundle** — the same operation
      // whose failure `execute` treats as a warning, blocking the release forever because one
      // past attempt went unanswered (#169).
      if (existing?.status === "pending" && operation.repeatable !== undefined) {
        warnings.push(
          `"${operation.operationId}" has an unconfirmed earlier outcome and declares its effect ` +
            `safe to repeat, so it is being performed again: ${operation.repeatable.reason}`,
        );
      } else if (existing?.status === "pending") {
        throw releaseError(
          ReleaseErrorCodes.RECONCILIATION_UNAVAILABLE,
          `"${operation.operationId}" was attempted and its outcome was never confirmed, and ` +
            `destination "${operation.destination}" cannot be queried to find out. Retrying ` +
            "would risk performing it twice, so it is refused until the outcome is established.",
          {
            category: "conflict",
            retryable: false,
            details: {
              runId: bundle.runId,
              operationId: operation.operationId,
              destination: operation.destination,
            },
          },
        );
      }

      const verdict =
        operation.requiresAuthority === undefined
          ? { authorized: true }
          : await this.#authorizer.check(bundle.runId, operation.requiresAuthority);

      if (!verdict.authorized) {
        const explanation =
          `"${operation.operationId}" requires authority "${operation.requiresAuthority}", ` +
          `which is not held. ${verdict.explanation ?? ""}`.trim();

        // A required operation without authority is a refusal, not a warning: §13.4 binds
        // release approval to exact inputs, and continuing past it would publish unapproved.
        if (criticality === "required") {
          throw releaseError(ReleaseErrorCodes.RELEASE_NOT_AUTHORIZED, explanation, {
            category: "policy",
            retryable: false,
            details: {
              runId: bundle.runId,
              operationId: operation.operationId,
              authority: operation.requiresAuthority,
            },
          });
        }

        // A best-effort operation is recorded as skipped rather than failed. It was never
        // attempted, and a `failed` receipt would claim the destination rejected it.
        written.push(
          await this.#record(
            bundle,
            operation,
            idempotencyKey,
            { status: "skipped", message: explanation },
            options.actor,
          ),
        );
        warnings.push(explanation);
        continue;
      }

      const adapter = this.#adapters.require(operation.destination);
      const outcome = await adapter.execute({ operation, idempotencyKey, runId: bundle.runId });
      written.push(await this.#record(bundle, operation, idempotencyKey, outcome, options.actor));

      if (outcome.status === "succeeded") continue;

      if (criticality === "best_effort") {
        warnings.push(
          `Best-effort operation "${operation.operationId}" did not succeed ` +
            `(${outcome.status}). The release is unaffected.`,
        );
        continue;
      }

      halted = true;
      haltState = outcome.status === "pending" ? "pending" : "failed";
    }

    latest = latestByKey(await this.#receipts.list(bundle.runId));
    const status = await this.status(bundle);
    const state: ReleaseOutcome["state"] =
      haltState ?? (status.state === "succeeded" ? "succeeded" : "pending");

    return { bundleId: bundle.bundleId, runId: bundle.runId, state, status, written, warnings };
  }

  /** Operations paired with their category and derived key, in execution order. */
  #plan(bundle: ReleaseBundle): {
    operation: ReleaseOperation;
    criticality: OperationCriticality;
    idempotencyKey: string;
  }[] {
    const entries = [
      ...bundle.required.map((operation) => ({
        operation: operation as ReleaseOperation,
        criticality: "required" as const,
      })),
      ...bundle.bestEffort.map((operation) => ({
        operation: operation as ReleaseOperation,
        criticality: "best_effort" as const,
      })),
    ];
    return entries.map((entry) => ({
      ...entry,
      idempotencyKey: deriveIdempotencyKey(entry.operation),
    }));
  }

  /** Write a receipt and emit its event (contract §6.4, §17). */
  async #record(
    bundle: ReleaseBundle,
    operation: ReleaseOperation,
    idempotencyKey: string,
    outcome: AdapterOutcome | { status: "skipped"; message: string },
    actor: ActorRef,
  ): Promise<ReleaseReceipt> {
    const at = this.#now().toISOString();
    const receipt: ReleaseReceipt = {
      schemaVersion: SCHEMA_VERSION,
      releaseId: this.#nextReleaseId(),
      runId: bundle.runId,
      // Recorded, never keyed on (ADR-0033). The trace can now say which release produced this
      // receipt; matching still happens on what the operation does, so a resumed bundle finds it.
      bundleId: bundle.bundleId,
      destination: operation.destination,
      operation: operation.kind,
      idempotencyKey,
      status: outcome.status,
      inputHashes: [...operation.inputHashes],
      ...(outcome.status === "succeeded" && outcome.remoteId !== undefined
        ? { remoteId: outcome.remoteId }
        : {}),
      ...(outcome.status === "succeeded" && outcome.remoteUrl !== undefined
        ? { remoteUrl: outcome.remoteUrl }
        : {}),
      // `pending` is not terminal, so it carries no completion time (contract §17).
      ...(outcome.status === "pending" ? {} : { completedAt: at }),
      ...(outcome.status === "failed"
        ? {
            error: {
              code: "ALDUS_RELEASE_OPERATION_FAILED",
              category: "provider" as const,
              message: outcome.message,
              retryable: outcome.retryable ?? true,
              occurredAt: at,
            },
          }
        : {}),
    };

    await this.#receipts.append(bundle.runId, receipt);
    await this.#events.emit(this.#event(bundle, operation, receipt, at, outcome, actor));
    return receipt;
  }

  /** The §6.4 event for one recorded outcome. */
  #event(
    bundle: ReleaseBundle,
    operation: ReleaseOperation,
    receipt: ReleaseReceipt,
    at: string,
    outcome: AdapterOutcome | { status: "skipped"; message: string },
    actor: ActorRef,
  ): AldusEvent {
    return {
      schemaVersion: SCHEMA_VERSION,
      eventId: this.#nextEventId(),
      occurredAt: at,
      episodeId: bundle.episodeId,
      runId: bundle.runId,
      action: `release.operation.${receipt.status}`,
      actor,
      inputRefs: [],
      outputRefs: [],
      idempotencyKey: receipt.idempotencyKey,
      details: {
        bundleId: bundle.bundleId,
        operationId: operation.operationId,
        kind: operation.kind,
        destination: operation.destination,
        releaseId: receipt.releaseId,
        ...("message" in outcome && outcome.message !== undefined
          ? { message: outcome.message }
          : {}),
      },
      ...(receipt.error === undefined ? {} : { error: receipt.error }),
    };
  }
}

/** Derive one operation's state from its latest receipt. */
function toStatus(
  operation: ReleaseOperation,
  criticality: OperationCriticality,
  idempotencyKey: string,
  receipt: ReleaseReceipt | undefined,
): OperationStatus {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    destination: operation.destination,
    criticality,
    idempotencyKey,
    state: receipt === undefined ? "not_started" : receipt.status,
    ...(receipt === undefined ? {} : { receipt }),
  };
}

/** A bundle's state is the state of its required operations (contract §17). */
function bundleState(required: readonly OperationStatus[]): BundleStatus["state"] {
  if (required.every((entry) => entry.state === "succeeded" || entry.state === "skipped")) {
    return "succeeded";
  }
  if (required.some((entry) => entry.state === "failed")) return "failed";
  if (required.some((entry) => entry.state === "pending")) return "pending";
  if (required.every((entry) => entry.state === "not_started")) return "not_started";
  return "in_progress";
}
