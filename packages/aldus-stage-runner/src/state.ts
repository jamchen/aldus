/**
 * Stage execution state, and its relationship to the event log.
 *
 * Architecture contract §7 lists exactly six files in a run directory and none of them holds a
 * `StageExecution`. That absence is not an oversight to paper over — it follows from §6.3 and
 * §6.4 read together:
 *
 * > §6.4: Every state mutation MUST emit an immutable event.
 * > §6.3: Attempts MUST be append-only audit records. A materialized manifest MAY summarize the
 * > current state.
 *
 * The event log is the audit record; a `StageExecution` is the *summary*, and §6.3 makes it
 * optional. So `stages.json` here is a **cache, not a source of truth**. Every lifecycle event
 * carries a complete snapshot of the attempt it describes, which makes the log sufficient to
 * rebuild every stage execution exactly. Deleting `stages.json` loses nothing (ADR-0008).
 *
 * That choice is what makes crash recovery honest. Mutations append the event first and write the
 * cache second, so a process killed between them leaves the log complete and the cache one event
 * behind — never the reverse, which would be a state change §6.4 has no record of. A watermark on
 * the cache makes the gap detectable, and replay closes it (§19.1 "recovery from partial
 * success").
 */

import { createHash } from "node:crypto";

import {
  assertValid,
  redact,
  type AldusEvent,
  type ArtifactRef,
  type StageAttempt,
  type StageExecution,
  type StageStatus,
  SCHEMA_VERSION,
} from "@aldus/core";
import { readFileOrUndefined, writeDocument, type EventStore } from "@aldus/file-store";
import { z } from "zod";

import { StageRunnerErrorCodes, stageRunnerError } from "./errors.js";

/**
 * Version of the `stages.json` file format.
 *
 * Separate from Core's `SCHEMA_VERSION`: this file is a cache owned by this package, and tying it
 * to Core's version would force a Core bump every time the cache's shape changed (ADR-0003 keeps
 * one version for the *Core* schema set, not for every package's private files).
 */
export const STAGE_STATE_FORMAT_VERSION = 1;

/** Action names for stage lifecycle events (contract §6.4). */
export const STAGE_EVENT_ACTIONS = {
  executionCreated: "stage.execution.created",
  attemptQueued: "stage.attempt.queued",
  attemptStarted: "stage.attempt.started",
  attemptSucceeded: "stage.attempt.succeeded",
  attemptFailed: "stage.attempt.failed",
  attemptCancelled: "stage.attempt.cancelled",
  attemptWaitingForGate: "stage.attempt.waiting_for_gate",
  attemptNoted: "stage.attempt.noted",
} as const;

/** @see STAGE_EVENT_ACTIONS */
export type StageEventAction = (typeof STAGE_EVENT_ACTIONS)[keyof typeof STAGE_EVENT_ACTIONS];

const LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set<string>([
  STAGE_EVENT_ACTIONS.executionCreated,
  STAGE_EVENT_ACTIONS.attemptQueued,
  STAGE_EVENT_ACTIONS.attemptStarted,
  STAGE_EVENT_ACTIONS.attemptSucceeded,
  STAGE_EVENT_ACTIONS.attemptFailed,
  STAGE_EVENT_ACTIONS.attemptCancelled,
  STAGE_EVENT_ACTIONS.attemptWaitingForGate,
]);

/**
 * Per-attempt data Core's `StageAttempt` has no field for.
 *
 * §11 requires a stage to "record the exact configuration used" and §19.1 requires idempotency
 * keys, but `StageAttempt`'s field list is transcribed verbatim from §6.3 and carries neither.
 * Rather than smuggle them into the Core record as unknown properties — which ADR-0004's
 * preservation rule would keep alive and a future Core minor version could collide with — they
 * live beside it, keyed by `attemptId`.
 */
export interface AttemptMetadata {
  /** Version of the stage definition that ran (contract §11, §20). */
  stageVersion: string;
  /** Digest of the configuration used (contract §11, §20). */
  configurationHash: string;
  /** The configuration itself, redacted (contract §19.2). */
  configuration: Record<string, unknown>;
  /** Deduplication key for external side effects (contract §19.1). */
  idempotencyKey: string;
  /** Whether the stage declared itself idempotent, and why not when it did not (contract §11). */
  idempotent: boolean;
  /** Reason the stage is not idempotent, when it declared itself so. */
  nonIdempotentReason?: string | undefined;
  /** Gate this attempt stopped at, when it stopped at one (contract §13). */
  gateId?: string | undefined;
  /** Hashes the eventual gate decision binds to (contract §13). */
  subjectHashes?: string[] | undefined;
  /** Operator-facing notes recorded during the attempt (contract §20). */
  notes?: string[] | undefined;
}

/** One stage execution, plus the metadata Core's record cannot carry. */
export interface StoredStageExecution {
  /** The Core record (contract §6.3), validated by Core's own schema. */
  execution: StageExecution;
  /** Per-attempt metadata, keyed by `attemptId`. */
  metadata: Record<string, AttemptMetadata>;
}

/** Contents of `stages.json`. */
export interface StageStateFile {
  /** Format version of this cache file. @see STAGE_STATE_FORMAT_VERSION */
  formatVersion: number;
  /**
   * Sequence of the last lifecycle event folded into this cache.
   *
   * The watermark that makes a crash between "event appended" and "cache written" detectable
   * rather than silent (contract §19.1).
   */
  lastEventSequence: number;
  /** Stage executions, in the order they were first created. */
  stages: StoredStageExecution[];
}

const attemptMetadataSchema = z.object({
  stageVersion: z.string(),
  configurationHash: z.string(),
  configuration: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string(),
  idempotent: z.boolean(),
  nonIdempotentReason: z.string().optional(),
  gateId: z.string().optional(),
  subjectHashes: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

const stageStateFileSchema = z.object({
  formatVersion: z.number().int().positive(),
  lastEventSequence: z.number().int().nonnegative(),
  stages: z.array(
    z.object({
      execution: z.unknown(),
      metadata: z.record(z.string(), attemptMetadataSchema),
    }),
  ),
});

/** Payload carried by every stage lifecycle event, sufficient to rebuild the cache. */
export interface StageLifecycleDetails {
  /** Full snapshot of the attempt after the transition. Absent for `stage.execution.created`. */
  attempt?: StageAttempt;
  /** Metadata for that attempt. Absent for `stage.execution.created`. */
  metadata?: AttemptMetadata;
  /** Status of the stage execution after the transition. */
  executionStatus: StageStatus;
  /** Version of the stage definition, present on `stage.execution.created`. */
  stageVersion?: string;
}

/**
 * Digest of a JSON value with keys ordered, so the same configuration always hashes the same.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical configurations built
 * in different orders would otherwise produce different digests — and §20's "which configuration
 * produced this" would answer differently for the same configuration.
 */
export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Serialise with object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
  return `{${entries.join(",")}}`;
}

/** An empty cache, for a Run with no stage executions yet. */
export function emptyStageState(): StageStateFile {
  return { formatVersion: STAGE_STATE_FORMAT_VERSION, lastEventSequence: 0, stages: [] };
}

/**
 * Read `stages.json`.
 *
 * An absent file reads as empty state: a Run that has not run a stage yet is an ordinary
 * condition (contract §6.2 `created`), not a missing record.
 */
export async function readStageState(path: string): Promise<StageStateFile> {
  const contents = await readFileOrUndefined(path);
  if (contents === undefined || contents.trim().length === 0) return emptyStageState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw stageRunnerError(
      StageRunnerErrorCodes.STAGE_STATE_MALFORMED,
      "Stored stage state is not valid JSON. Atomic writes make a torn file impossible, so this " +
        "means the file was edited or replaced by something other than the runner. It is a cache " +
        "and can be deleted; the event log rebuilds it (ADR-0008).",
      { category: "io", retryable: false, details: { path } },
    );
  }

  const result = stageStateFileSchema.safeParse(parsed);
  if (!result.success) {
    throw stageRunnerError(
      StageRunnerErrorCodes.STAGE_STATE_MALFORMED,
      "Stored stage state does not match the expected shape. It is a cache and can be deleted; " +
        "the event log rebuilds it (ADR-0008).",
      { category: "io", retryable: false, details: { path } },
    );
  }

  // A newer format version is not readable by this build, and guessing would corrupt the cache on
  // the next write. Rebuilding from the log is always available and always correct.
  if (result.data.formatVersion !== STAGE_STATE_FORMAT_VERSION) {
    return emptyStageState();
  }

  const stages: StoredStageExecution[] = result.data.stages.map((stage) => ({
    execution: assertValid("StageExecution", stage.execution),
    metadata: stage.metadata,
  }));

  return {
    formatVersion: result.data.formatVersion,
    lastEventSequence: result.data.lastEventSequence,
    stages,
  };
}

/** Write `stages.json` atomically. */
export async function writeStageState(path: string, state: StageStateFile): Promise<void> {
  await writeDocument(path, state);
}

/**
 * Fold one lifecycle event into a cache.
 *
 * Pure, and the single definition of how an event changes stage state — the runner's live updates
 * and the rebuild path both go through it, so a cache built by replay cannot drift from one built
 * incrementally. A test asserts they agree.
 */
export function applyLifecycleEvent(state: StageStateFile, event: AldusEvent): StageStateFile {
  if (!LIFECYCLE_ACTIONS.has(event.action)) return state;
  const details = event.details as StageLifecycleDetails | undefined;
  const stageId = event.stageId;
  if (details === undefined || stageId === undefined) return state;

  const stages = [...state.stages];
  const index = stages.findIndex((stage) => stage.execution.stageId === stageId);

  if (index === -1) {
    stages.push({
      execution: {
        schemaVersion: SCHEMA_VERSION,
        runId: event.runId,
        stageId,
        ...(details.stageVersion !== undefined ? { stageVersion: details.stageVersion } : {}),
        status: details.executionStatus,
        attempts: details.attempt === undefined ? [] : [details.attempt],
        ...(details.attempt?.startedAt !== undefined
          ? { startedAt: details.attempt.startedAt }
          : {}),
      },
      metadata:
        details.attempt !== undefined && details.metadata !== undefined
          ? { [details.attempt.attemptId]: details.metadata }
          : {},
    });
  } else {
    const current = stages[index];
    /* v8 ignore next */
    if (current === undefined) return state;

    const attempts = [...current.execution.attempts];
    const metadata = { ...current.metadata };

    if (details.attempt !== undefined) {
      const existing = attempts.findIndex(
        (attempt) => attempt.attemptId === details.attempt?.attemptId,
      );
      // Replacing in place is not editing history: the append-only record is the event log, and
      // this cache holds the latest known state of each attempt. §6.3's guarantee lives in the
      // log, which never rewrites a line.
      if (existing === -1) attempts.push(details.attempt);
      else attempts[existing] = details.attempt;
      if (details.metadata !== undefined) metadata[details.attempt.attemptId] = details.metadata;
    }

    const startedAt = current.execution.startedAt ?? attempts[0]?.startedAt;
    const finishedAt = isTerminal(details.executionStatus)
      ? (details.attempt?.finishedAt ?? current.execution.finishedAt)
      : undefined;

    stages[index] = {
      execution: {
        ...current.execution,
        status: details.executionStatus,
        attempts,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(finishedAt !== undefined ? { finishedAt } : {}),
      },
      metadata,
    };
  }

  return {
    formatVersion: STAGE_STATE_FORMAT_VERSION,
    lastEventSequence: Math.max(state.lastEventSequence, event.sequence ?? 0),
    stages,
  };
}

/** True for a status no further work follows within the same attempt. */
export function isTerminal(status: StageStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "waiting_for_gate"
  );
}

/**
 * Rebuild stage state from a Run's event log.
 *
 * The proof that the cache is disposable. §6.4 requires every mutation to emit an event, and every
 * lifecycle event here carries a full attempt snapshot, so the log alone reconstructs exactly what
 * the cache held.
 */
export async function rebuildStageState(
  events: EventStore,
  runId: string,
): Promise<StageStateFile> {
  const { events: log } = await events.read(runId);
  return log.reduce(applyLifecycleEvent, emptyStageState());
}

/**
 * Bring a cache up to date with the log, if a crash left it behind.
 *
 * Only replays events *after* the watermark, so the ordinary case costs one log read and no
 * recomputation. Returns the state and whether anything was repaired, so a caller can report a
 * recovery rather than hiding it (contract §19.1, §20).
 */
export async function reconcileStageState(
  events: EventStore,
  runId: string,
  cached: StageStateFile,
): Promise<{ state: StageStateFile; repaired: boolean }> {
  const { events: log } = await events.read(runId);
  const pending = log.filter(
    (event) =>
      LIFECYCLE_ACTIONS.has(event.action) && (event.sequence ?? 0) > cached.lastEventSequence,
  );
  if (pending.length === 0) return { state: cached, repaired: false };
  return { state: pending.reduce(applyLifecycleEvent, cached), repaired: true };
}

/** Redact a configuration before it reaches a durable record (contract §19.2). */
export function redactConfiguration(
  configuration: Record<string, unknown>,
): Record<string, unknown> {
  return redact(configuration) as Record<string, unknown>;
}

/** Collect the artifacts recorded across an attempt. */
export function outputsOf(attempt: StageAttempt | undefined): ArtifactRef[] {
  return attempt === undefined ? [] : [...attempt.outputArtifacts];
}
