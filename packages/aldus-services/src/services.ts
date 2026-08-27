/**
 * The Aldus application services (architecture contract §18).
 *
 * §18: "Core behavior MUST be available through a programmatic API. CLI and MCP are adapters over
 * the same application services." This is that API. Every decision lives here; an adapter parses
 * input, renders output, and chooses an exit code or a response envelope.
 *
 * The discipline that keeps that true: **no method returns a string meant for a human**, and no
 * method reads `process.argv`, `process.env`, or a terminal. If a behaviour is not reachable
 * through a method on this class, the Production MCP (WP-11) will have to reimplement it — and
 * two implementations of an approval path is exactly the divergence §3.6 warns about.
 */

import type { ActorRef, ArtifactRef, EpisodeRef, RunManifest } from "@aldus-runtime/core";
import {
  AldusError,
  SCHEMA_VERSION,
  formatEpisodeId,
  isCanonicalId,
  newEventId,
  newRunId,
  validate,
} from "@aldus-runtime/core";
import { isArchived, type ArtifactRecord } from "@aldus-runtime/artifact-registry";
import { decideRework, type ReworkVerdict } from "./rework.js";
import { deriveReworkRounds, type AttemptWithMetadata } from "./rework-rounds.js";
import { initWorkspace } from "@aldus-runtime/file-store";
import type { GateStatus } from "@aldus-runtime/gate-engine";
import { operationsOf, type ReleaseBundle, type ReleaseOutcome } from "@aldus-runtime/release";
import type {
  StageRunResult,
  StageRunner,
  StoredStageExecution,
} from "@aldus-runtime/stage-runner";
import { segmentsAwaitingAcceptance } from "@aldus-runtime/tts-ledger";
import type {
  PerformanceScript,
  RecordTakeInput,
  TakeDecision,
  TtsRequestPlan,
} from "@aldus-runtime/tts-ledger";

import { requireActor } from "./actor.js";
import type { ReconciliationResolution } from "./spend-service.js";
import type { AldusContext } from "./context.js";
import { summariseCosts } from "./costs.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";
import {
  decideActions,
  enforcedBlockerFor,
  type ActionPolicyInput,
  type StageSnapshot,
  type StageSummaryStatus,
} from "./nextaction.js";
import type {
  ArchiveReport,
  ArtifactLineageReport,
  ArtifactReport,
  CleanupPlanReport,
  CostReport,
  EpisodeInspection,
  GateDecisionReport,
  InitReport,
  Inspection,
  PlanReport,
  ReleaseBundleReport,
  ReleaseExecutionReport,
  ReleaseReconciliationReport,
  ReleaseReport,
  RunInspection,
  RunReport,
  RunSummary,
  ScriptReport,
  StageReport,
  StageRunReport,
  StartRunReport,
  ReworkStatusReport,
  StatusReport,
  SynthesisReport,
  TakeDecisionReport,
  TakeReport,
} from "./reports.js";
import { ok, refused, unsuccessful, type ServiceResult } from "./results.js";
import { deriveRunState, type RunState } from "./runstate.js";
import { terminalStagesOf } from "./workflow.js";

/** What `init` needs. */
export interface InitRequest {
  /** Create an Episode as well as the workspace. */
  episode?: {
    /** Canonical identity (§6.1). Derived from `showId` and `slug` when absent. */
    episodeId?: string;
    showId: string;
    slug?: string;
    title?: string;
    legacyRef?: string;
  };
  /** Replace an existing Episode instead of refusing. */
  force?: boolean;
  actor?: ActorRef;
}

/** What `startRun` needs (contract §6.2). */
export interface StartRunRequest {
  workflowId: string;
  workflowVersion: string;
  /** Supplied for deterministic tests; defaults to a fresh ULID-based id. */
  runId?: string;
  codeRevision?: string;
  /**
   * The stages this Run intends to reach (contract §11, ADR-0026).
   *
   * Defaults to the graph's terminal stages — those nothing else waits on — when the graph
   * declares ordering edges, and to every stage it names when it does not (ADR-0028).
   *
   * Declare it when this Run will deliberately stop short: a conditional stage that this edition
   * skips, or a run that never publishes. A graph says what a workflow *can* do and cannot say
   * what one Run set out to do.
   */
  goalStages?: readonly string[];
  actor?: ActorRef;
}

/** What `cancelRun` needs (contract §19.1, §19.2). */
export interface CancelRunRequest {
  runId: string;
  /** Why the Run was abandoned. Optional, and worth supplying: §20 asks trace what happened. */
  reason?: string;
  actor?: ActorRef;
}

/** What `runStage` and `retryStage` need (contract §11). */
export interface RunStageRequest {
  runId: string;
  stageId: string;
  input?: unknown;
  stageVersion?: string;
  configuration?: Record<string, unknown>;
  inputArtifacts?: readonly ArtifactRef[];
  /** Take over a stage claimed by a crashed runner. */
  force?: boolean;
  signal?: AbortSignal;
  actor?: ActorRef;
}

/** What `approve` and `reject` need (contract §3.6, §13). */
export interface GateDecisionRequest {
  runId: string;
  gateId: string;
  comment?: string;
  /**
   * A decision made by someone other than the actor running this command (§19.2).
   *
   * The **acting** actor becomes `transcription.recordedBy`; `decidedBy` becomes the person named
   * here. The transcriber is derived rather than accepted, because a transcriber that could name
   * itself could name someone else.
   *
   * `verbatim` is required with it and not separately optional: a transcriber with no record of
   * what they were told cannot be checked against anything.
   */
  transcribing?: { decidedBy: ActorRef; verbatim: string };
  /** Overrides the gate definition's default. */
  expiresOnChange?: boolean;
  actor?: ActorRef;
}

/**
 * What a waiver needs, which is not what a decision needs.
 *
 * `reason` is **required** where `GateDecisionRequest.comment` is optional, and there is no
 * `expiresOnChange`: a waiver's cannot be chosen. Both differences are the point of the type —
 * a waiver recorded in the shape of an approval is the thing this verb exists to stop.
 */
export interface GateWaiverRequest {
  runId: string;
  gateId: string;
  /** Why the check is being bypassed. Recorded as the decision's comment (§19.2). */
  reason: string;
  actor?: ActorRef;
}

/** Application services bound to one workspace. */
export class AldusServices {
  readonly #context: AldusContext;

  constructor(context: AldusContext) {
    this.#context = context;
  }

  /** The bound context, for an adapter that needs the registries. */
  get context(): AldusContext {
    return this.#context;
  }

  // ---------------------------------------------------------------------------------------------
  // Workspace lifecycle
  // ---------------------------------------------------------------------------------------------

  /**
   * Create the workspace, and optionally the Episode (contract §7, §6.1).
   *
   * Idempotent for the directory structure. Creating a second Episode in a workspace that has one
   * is refused unless forced: §6.1 makes the Episode "the durable content identity", and silently
   * replacing it would orphan every Run that referenced the old one.
   */
  async init(request: InitRequest = {}): Promise<ServiceResult<InitReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "init");
    void actor;

    const root = this.#context.workspace.layout.root;
    const existed = (await this.#context.workspace.episodes.get()) !== undefined;
    await initWorkspace(root);

    if (request.episode === undefined) {
      return ok({ workspaceRoot: root, created: !existed });
    }

    if (existed && request.force !== true) {
      const current = await this.#context.workspace.episodes.get();
      return refused({
        reason: "episode_already_exists",
        explanation:
          `This workspace already holds Episode "${current?.episodeId ?? "unknown"}". An Episode ` +
          "is the durable content identity (contract §6.1), so replacing it would orphan every " +
          "Run that referenced it. Pass force to replace it deliberately.",
        details: { episodeId: current?.episodeId },
      });
    }

    const episode = this.#buildEpisode(request.episode);
    await this.#context.workspace.episodes.put(episode);
    return ok({ workspaceRoot: root, created: !existed, episode });
  }

  /** Build and validate an `EpisodeRef` from an init request. */
  #buildEpisode(input: NonNullable<InitRequest["episode"]>): EpisodeRef {
    const episodeId =
      input.episodeId ??
      (input.slug === undefined ? undefined : formatEpisodeId(input.showId, input.slug));

    if (episodeId === undefined) {
      throw serviceError(
        ServiceErrorCodes.INVALID_REQUEST,
        "Creating an Episode needs either an explicit episodeId or a slug to derive one from " +
          "(contract §6.1).",
        { category: "validation", details: { showId: input.showId } },
      );
    }
    if (!isCanonicalId(episodeId)) {
      throw serviceError(
        ServiceErrorCodes.INVALID_REQUEST,
        `"${episodeId}" is not a canonical content identity. Contract §6.1 expects four ` +
          'colon-separated segments, e.g. "show:{show-id}:episode:{episode-slug}".',
        { category: "validation", details: { episodeId } },
      );
    }

    const candidate: EpisodeRef = {
      schemaVersion: SCHEMA_VERSION,
      episodeId,
      showId: input.showId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.legacyRef !== undefined ? { legacyRef: input.legacyRef } : {}),
    };

    const result = validate("EpisodeRef", candidate);
    if (!result.ok) {
      throw serviceError(ServiceErrorCodes.INVALID_REQUEST, "The Episode is not valid.", {
        category: "validation",
        details: { issues: result.error.details },
      });
    }
    return result.value;
  }

  /**
   * Create a Run (contract §6.2).
   *
   * Not in §18's V1 verb list, and added deliberately: without it every other verb is
   * unreachable, because a stage runs against a Run. See ADR-0011.
   */
  async startRun(request: StartRunRequest): Promise<ServiceResult<StartRunReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "start");
    void actor;

    const episode = await this.#context.workspace.episodes.get();
    if (episode === undefined) {
      throw serviceError(
        ServiceErrorCodes.EPISODE_NOT_FOUND,
        "This workspace has no Episode, so there is nothing to produce. Run init with an " +
          "Episode first (contract §6.1).",
        { category: "not_found", details: { workspaceRoot: this.#context.workspace.layout.root } },
      );
    }

    const goalStages = this.#resolveGoalStages(request.goalStages);

    const timestamp = this.#context.now().toISOString();
    const manifest: RunManifest = {
      schemaVersion: SCHEMA_VERSION,
      runId: request.runId ?? newRunId(),
      episode,
      workflowId: request.workflowId,
      workflowVersion: request.workflowVersion,
      status: "created",
      ...(request.codeRevision !== undefined ? { codeRevision: request.codeRevision } : {}),
      ...(goalStages !== undefined ? { goalStages: [...goalStages] } : {}),
      knowledgePacks: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const validated = validate("RunManifest", manifest);
    if (!validated.ok) {
      throw serviceError(ServiceErrorCodes.INVALID_REQUEST, "The Run manifest is not valid.", {
        category: "validation",
        details: { issues: validated.error.details },
      });
    }

    await this.#context.workspace.runs.create(validated.value);
    return ok({ run: validated.value });
  }

  /**
   * Abandon a Run (contract §19.1, §19.2).
   *
   * The one Run state that cannot be derived. §5.1 makes long pauses ordinary, so silence in an
   * append-only log says nothing about intent — a Run someone gave up on and one they are still
   * thinking about look identical. Abandonment is a decision, so it is recorded as one, with the
   * actor who made it.
   *
   * Distinct from `RunStageOptions.signal`, which aborts an in-flight attempt: that stops the
   * work, this retires the Run.
   */
  async cancelRun(request: CancelRunRequest): Promise<ServiceResult<RunReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "cancel");
    const manifest = await this.#requireRun(request.runId);

    if (manifest.cancellation !== undefined) {
      return refused({
        reason: "run_already_cancelled",
        explanation:
          `Run "${request.runId}" was already cancelled at ${manifest.cancellation.cancelledAt}. ` +
          "Cancelling again would overwrite the record of who abandoned it and when, which §20's " +
          "production trace depends on.",
        details: { runId: request.runId, cancelledAt: manifest.cancellation.cancelledAt },
      });
    }

    const at = this.#context.now().toISOString();
    await this.#context.workspace.runs.update(request.runId, (current) => ({
      ...current,
      cancellation: {
        cancelledAt: at,
        cancelledBy: actor,
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
      },
      updatedAt: at,
    }));

    // Sequential, never nested: `runs.update` and `events.append` each take the Run lock, and
    // ADR-0005's guard refuses a re-entrant acquisition rather than deadlocking on it.
    await this.#context.workspace.events.append(request.runId, {
      schemaVersion: SCHEMA_VERSION,
      eventId: newEventId(),
      occurredAt: at,
      episodeId: manifest.episode.episodeId,
      runId: request.runId,
      action: "run.cancelled",
      actor,
      previousState: "running",
      resultingState: "cancelled",
      inputRefs: [],
      outputRefs: [],
      ...(request.reason !== undefined ? { details: { reason: request.reason } } : {}),
    });

    return ok(await this.#runReport(request.runId));
  }

  /**
   * Settle what a Run is trying to reach, refusing a goal the graph does not contain.
   *
   * Validated only when a graph is present: without one there is nothing to check against, and
   * refusing a goal we cannot verify would block the very adopters who have not adopted graphs.
   *
   * A typo is refused here rather than discovered later, because the alternative is a Run that
   * silently never completes — the same shape as a config key that loads and is dropped, where
   * the symptom appears nowhere near the cause.
   */
  #resolveGoalStages(requested: readonly string[] | undefined): readonly string[] | undefined {
    const graph = this.#context.workflow;

    if (requested === undefined) {
      if (graph === undefined) return undefined;
      // Terminals when the graph declares edges; every stage otherwise. Without edges every stage
      // is trivially terminal, so the narrower answer would be the same list dressed up as a
      // deduction (ADR-0028).
      const terminals = terminalStagesOf(graph);
      return terminals.length > 0 ? terminals : graph.stages.map((node) => node.stageId);
    }

    if (graph !== undefined) {
      const known = new Set(graph.stages.map((node) => node.stageId));
      const unknown = requested.filter((stageId) => !known.has(stageId));
      if (unknown.length > 0) {
        throw serviceError(
          ServiceErrorCodes.INVALID_REQUEST,
          `The workflow graph contains no stage named ${unknown.map((id) => `"${id}"`).join(", ")}. ` +
            "A goal the graph does not contain can never be reached, so the Run would never " +
            "complete and nothing would say why.",
          {
            category: "validation",
            details: { unknownGoalStages: unknown, knownStages: [...known] },
          },
        );
      }
    }

    return requested;
  }

  // ---------------------------------------------------------------------------------------------
  // Reading state
  // ---------------------------------------------------------------------------------------------

  /**
   * The workspace's current state and the next safe action (contract §18, §24).
   *
   * §24 requires an operator to see both "without reading chat history", so this needs no actor:
   * requiring identity to *look* would put configuration between an operator and the answer.
   */
  async status(runId?: string): Promise<ServiceResult<StatusReport>> {
    const workspaceRoot = this.#context.workspace.layout.root;
    const episode = await this.#context.workspace.episodes.get();
    const runIds = await this.#context.workspace.runs.list();
    const summaries: RunSummary[] = [];

    // Derived per Run rather than read off the manifest. Costs one stage-state read each, which
    // is what makes a list of Runs answer "which of these is finished" at all (ADR-0026).
    const runner = this.#context.runnerFor(this.#actorOrSystem());
    for (const id of runIds) {
      const manifest = await this.#context.workspace.runs.get(id);
      if (manifest === undefined) continue;
      const state = await this.#runState(id, manifest, runner);
      summaries.push(toSummary(manifest, state));
    }

    const focusId = runId ?? (summaries.length === 1 ? summaries[0]?.runId : undefined);
    const focused = focusId === undefined ? undefined : await this.#runReport(focusId);

    return ok({
      workspaceRoot,
      initialized: episode !== undefined || runIds.length > 0,
      ...(episode !== undefined ? { episode } : {}),
      runs: summaries,
      ...(focused !== undefined ? { focused } : {}),
      summary: workspaceSummary(episode, summaries, focused),
    });
  }

  /**
   * Resolve an identifier to an Episode or a Run and report on it (contract §18).
   *
   * A Run id is tried first: §6.1 gives Episodes a colon-separated canonical form and §6.2 gives
   * Runs an opaque one, so the two are unambiguous, and trying the cheaper lookup first keeps a
   * typo from being reported as the wrong kind of thing.
   */
  async inspect(subject: string): Promise<ServiceResult<Inspection>> {
    const manifest = await this.#context.workspace.runs.get(subject);
    if (manifest !== undefined) {
      const report = await this.#runReport(subject);
      const artifacts = await this.#context.workspace.runs.listRecords(subject, "artifacts");
      const approvals = await this.#context.workspace.runs.listRecords(subject, "approvals");
      const releases = await this.#context.workspace.runs.listRecords(subject, "release");
      const inspection: RunInspection = {
        kind: "run",
        report,
        artifacts,
        approvals: approvals.length,
        releases,
      };
      return ok(inspection);
    }

    const episode = await this.#context.workspace.episodes.get();
    if (episode !== undefined && episode.episodeId === subject) {
      const status = await this.status();
      const runs = status.outcome === "ok" ? status.data.runs : [];
      const inspection: EpisodeInspection = { kind: "episode", episode, runs };
      return ok(inspection);
    }

    throw serviceError(
      ServiceErrorCodes.SUBJECT_NOT_FOUND,
      `"${subject}" names neither a Run in this workspace nor its Episode.`,
      { category: "not_found", details: { subject } },
    );
  }

  /**
   * Artifacts recorded against a Run (contract §8, §8.1, §20).
   *
   * Registry-backed, with §7's `artifacts.json` still read so a Run produced before the registry
   * existed remains inspectable. Entries the registry does not hold are reported separately rather
   * than merged: presenting one as registered would claim provenance and archival state nobody
   * collected, and §3.4 makes the durable record authoritative.
   */
  async artifacts(runId: string): Promise<ServiceResult<ArtifactReport>> {
    await this.#requireRun(runId);
    const records = await this.#context.artifacts.listByRun(runId);
    const collection = await this.#context.workspace.runs.listRecords(runId, "artifacts");

    const registeredIds = new Set(records.map((record) => record.artifact.artifactId));
    return ok({
      runId,
      artifacts: records.map((record) => record.artifact),
      records,
      unregistered: collection.filter((artifact) => !registeredIds.has(artifact.artifactId)),
      unarchivedIrreplaceable: records.filter(
        (record) => record.artifact.reconstructability === "irreplaceable" && !isArchived(record),
      ),
    });
  }

  /**
   * Where an artifact came from and what came of it (contract §20).
   *
   * §20 requires production trace to answer "which inputs, code, packs, and configuration were
   * used" and "which artifact became canonical"; this is that query. Lineage edges are digests
   * rather than IDs, so re-registering identical bytes under a new ID keeps derived artifacts
   * correctly attributed.
   */
  async artifactLineage(artifactId: string): Promise<ServiceResult<ArtifactLineageReport>> {
    const graph = await this.#context.artifacts.lineage();
    const record = graph.get(artifactId);
    if (record === undefined) {
      throw serviceError(
        ServiceErrorCodes.ARTIFACT_NOT_REGISTERED,
        `No artifact "${artifactId}" is registered in this workspace.`,
        { category: "not_found", details: { artifactId } },
      );
    }
    return ok({
      artifactId,
      record,
      producer: graph.producerOf(artifactId),
      inputs: graph.inputsOf(artifactId),
      consumers: graph.consumersOf(artifactId),
      ancestors: graph.ancestorsOf(artifactId),
      descendants: graph.descendantsOf(artifactId),
    });
  }

  /**
   * Decide what a cleanup may remove, without removing anything (contract §8.1).
   *
   * Read-only, so it needs no actor: an operator must be able to see whether a cleanup is safe
   * before configuring an identity to perform one. Defaults to every artifact the Run produced.
   */
  async planArtifactCleanup(
    runId: string,
    artifactIds?: readonly string[],
  ): Promise<ServiceResult<CleanupPlanReport>> {
    await this.#requireRun(runId);
    const candidates =
      artifactIds ??
      (await this.#context.artifacts.listByRun(runId)).map((record) => record.artifact.artifactId);
    const plan = await this.#context.artifacts.planCleanup(candidates);
    return ok({
      runId,
      removable: plan.removable,
      blocked: plan.blocked,
      unknownArtifactIds: plan.unknownArtifactIds,
      safe: plan.safe,
    });
  }

  /**
   * Take archival custody of every irreplaceable artifact that lacks it (contract §8.1).
   *
   * §8.1 requires irreplaceable artifacts to be archived **before** disposable working files are
   * cleaned, so this is the operation an operator needs before any cleanup. Idempotent: an
   * artifact already archived under the same digest is reported as such rather than re-copied.
   */
  async archiveIrreplaceable(request: {
    runId: string;
    actor?: ActorRef;
  }): Promise<ServiceResult<ArchiveReport>> {
    requireActor(request.actor ?? this.#context.actor, "archive");
    await this.#requireRun(request.runId);

    // Scoped to this Run rather than calling the registry's workspace-wide sweep: the caller asked
    // about one Run, and silently archiving another Run's artifacts would be a side effect nobody
    // requested — however benign archiving is.
    const irreplaceable = (await this.#context.artifacts.listByRun(request.runId)).filter(
      (record) => record.artifact.reconstructability === "irreplaceable",
    );
    const alreadyArchived = irreplaceable.filter((record) => isArchived(record));
    const archived: ArtifactRecord[] = [];
    for (const record of irreplaceable) {
      if (isArchived(record)) continue;
      archived.push(await this.#context.artifacts.archiveArtifact(record.artifact.artifactId));
    }
    return ok({ runId: request.runId, archived, alreadyArchived });
  }

  /** Cost records and their summary (contract §19.3). */
  async costs(runId: string): Promise<ServiceResult<CostReport>> {
    await this.#requireRun(runId);
    const records = await this.#context.workspace.runs.listRecords(runId, "costs");
    // Reservations too, not only cost records. An unresolved charge lives in the reservation store
    // and blocks every later dispatch on its grant, and reading records alone made that state
    // invisible in the one command an operator checks when the money looks wrong (#215).
    const reservations = await this.#context.spendStatus(runId);
    return ok({
      runId,
      records,
      summary: summariseCosts(records),
      // **Everything still holding authorization**, not only what needs reconciling.
      //
      // `requiresReconciliation` is `status === "billing_unknown"`, so a reservation whose dispatch
      // began and never settled — a process killed mid-round, holding its full reserved amount —
      // was filtered out of the report built to make blocked money visible. Measured in the first
      // adopter: $12 held, invisible here, while `costs` printed a total as if the Run were idle.
      //
      // `reserved` with an `execution` is not by itself a fault: an in-flight dispatch looks
      // identical, and the runtime cannot tell a live one from an abandoned one. So it is shown
      // rather than flagged, and the render says which kind each is.
      unresolved: reservations.filter(
        (entry) => entry.status === "billing_unknown" || entry.status === "reserved",
      ),
    });
  }

  /** Release receipts and what they imply (contract §17). */
  async releaseStatus(runId: string): Promise<ServiceResult<ReleaseReport>> {
    await this.#requireRun(runId);
    const receipts = await this.#context.workspace.runs.listRecords(runId, "release");
    return ok({
      runId,
      receipts,
      pending: receipts.filter((receipt) => receipt.status === "pending"),
      failed: receipts.filter((receipt) => receipt.status === "failed"),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Release (contract §17)
  // ---------------------------------------------------------------------------------------------

  /**
   * A bundle's derived state (contract §17, §19.1).
   *
   * Read-only. State is derived from the stored receipts on every call rather than held, for the
   * reason ADR-0009 derives gate state: a stored "in progress" flag survives a crash the operation
   * it describes did not, and an operator then reads something that was true once.
   */
  async releaseBundleStatus(request: {
    bundle: ReleaseBundle;
  }): Promise<ServiceResult<ReleaseBundleReport>> {
    await this.#requireRun(request.bundle.runId);
    const status = await this.#context
      .releaseExecutorFor(request.bundle.runId)
      .status(request.bundle);
    return ok({ runId: request.bundle.runId, bundleId: request.bundle.bundleId, status });
  }

  /**
   * Repair the local record against the destinations (contract §17).
   *
   * A receipt can be lost while the remote operation succeeded, and retrying blindly then
   * publishes twice. Reconciliation asks each adapter what the destination actually holds and
   * repairs the record, so the next execution skips what already happened.
   */
  async reconcileRelease(request: {
    bundle: ReleaseBundle;
    actor?: ActorRef;
  }): Promise<ServiceResult<ReleaseReconciliationReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "reconcile");
    await this.#requireRun(request.bundle.runId);
    this.#requireReleaseAdapters(request.bundle);

    return this.#releaseAttempt(request.bundle.runId, async () => {
      const report = await this.#context
        .releaseExecutorFor(request.bundle.runId)
        .reconcile(request.bundle, { actor });
      return ok({
        runId: request.bundle.runId,
        bundleId: request.bundle.bundleId,
        report,
      });
    });
  }

  /**
   * Execute a release bundle (contract §17, §13.4).
   *
   * **Reconciliation always runs first, and there is no way to ask for it to be skipped.**
   * `@aldus-runtime/release` exposes that switch so its own tests can demonstrate the duplicate publish it
   * prevents; exposing it here would make double-publishing a caller's option, and ADR-0015 places
   * policy on Aldus's side of the injection point. An adapter that cannot be queried is refused
   * rather than retried.
   *
   * Authority comes from `@aldus-runtime/gate-engine` and is never re-decided here: §13.4 keeps uploading
   * and making public separate, and a required operation whose authority is not held is a refusal
   * rather than a warning.
   */
  async executeRelease(request: {
    bundle: ReleaseBundle;
    actor?: ActorRef;
  }): Promise<ServiceResult<ReleaseExecutionReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "release");
    await this.#requireRun(request.bundle.runId);
    this.#requireReleaseAdapters(request.bundle);

    return this.#releaseAttempt(request.bundle.runId, async () => {
      const outcome = await this.#context
        .releaseExecutorFor(request.bundle.runId)
        .execute(request.bundle, { actor });
      const report: ReleaseExecutionReport = {
        runId: request.bundle.runId,
        bundleId: request.bundle.bundleId,
        outcome,
      };
      if (outcome.state === "succeeded") return ok(report);
      return unsuccessful(report, explainReleaseOutcome(outcome));
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Performance and synthesis (contract §14, §15)
  // ---------------------------------------------------------------------------------------------

  /** Record a PerformanceScript (contract §14.1). */
  async recordPerformanceScript(request: {
    script: PerformanceScript;
    actor?: ActorRef;
  }): Promise<ServiceResult<ScriptReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "record script");
    const manifest = await this.#requireRun(request.script.runId);
    const script = await this.#context
      .ledgerFor()
      .recordScript(request.script, manifest.episode.episodeId, actor);
    return ok({ runId: script.runId, script });
  }

  /**
   * Record a synthesis request plan (contract §13.2, §15).
   *
   * A plan is the thing an operator approves, so recording one is not authorization — it is what
   * makes authorization possible. Nothing here spends anything.
   */
  async recordSynthesisPlan(request: {
    plan: TtsRequestPlan;
    actor?: ActorRef;
  }): Promise<ServiceResult<PlanReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "record plan");
    const manifest = await this.#requireRun(request.plan.runId);
    const plan = await this.#context
      .ledgerFor(request.plan)
      .recordPlan(request.plan, manifest.episode.episodeId, actor);
    return ok({ runId: plan.runId, plan });
  }

  /**
   * Synthesise one segment of an approved plan (contract §13.2, §15).
   *
   * This is the only path from Aldus to a synthesis provider, and it authorizes before it calls —
   * see `synthesis.ts` for why the adapter is unreachable rather than merely guarded. A plan whose
   * §13.2 authorization does not currently hold is **refused with the adapter untouched**, so no
   * money is spent on content nobody approved.
   *
   * A missing adapter throws rather than refusing: ADR-0015 makes supplying one the adopter's
   * responsibility, and no approval an operator could grant would conjure it.
   */
  async synthesiseSegment(request: {
    plan: TtsRequestPlan;
    segmentId: string;
    actor?: ActorRef;
  }): Promise<ServiceResult<SynthesisReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "synthesise");
    const manifest = await this.#requireRun(request.plan.runId);

    const gateway = this.#context.synthesisFor(request.plan);
    if (gateway === undefined) {
      throw serviceError(
        ServiceErrorCodes.ADAPTER_NOT_WIRED,
        "No synthesis adapter is wired, so nothing can perform synthesis. Aldus never calls a " +
          "provider itself (contract §4.2, §15.1); an adopter integration supplies the adapter " +
          "(§4.3).",
        // Not "policy": a policy refusal is something an operator could approve away, and no
        // approval conjures an adapter. Misclassifying it tells a caller to wait and retry
        // forever (ADR-0015, and the doc comment on ADAPTER_NOT_WIRED).
        { category: "validation", retryable: false, details: { runId: request.plan.runId } },
      );
    }

    const result = await gateway.synthesise({
      plan: request.plan,
      segmentId: request.segmentId,
      episodeId: manifest.episode.episodeId,
      actor,
    });

    if (!result.permitted) {
      return refused({
        reason: "synthesis_not_authorized",
        explanation: result.explanation,
        details: { runId: request.plan.runId, planId: request.plan.planId },
      });
    }

    return ok({
      runId: request.plan.runId,
      planId: request.plan.planId,
      segmentId: request.segmentId,
      take: result.take,
      adapterId: gateway.adapterId,
    });
  }

  /**
   * Record a charge that was incurred without a valid authorization (contract §13.2, §20).
   *
   * An escape hatch, and deliberately an awkward one. §13.2's enforcement point is before a Worker
   * runs, so by the time a charge reaches the ledger the money is gone — and refusing to record it
   * would leave §20's trace unable to answer what something cost. This admits the record and marks
   * it plainly.
   *
   * It is **not** a synthesis path: it performs no synthesis and cannot reach an adapter. Recording
   * a charge is not the same as being allowed to incur one.
   */
  async recordUnauthorizedCharge(request: {
    plan: TtsRequestPlan;
    segmentId: string;
    take: RecordTakeInput["take"];
    reason: string;
    rejectedAuthorizationId?: string;
    actor?: ActorRef;
  }): Promise<ServiceResult<SynthesisReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "record unauthorized charge");
    const manifest = await this.#requireRun(request.plan.runId);

    const take = await this.#context.ledgerFor(request.plan).recordUnauthorizedCharge({
      runId: request.plan.runId,
      planId: request.plan.planId,
      segmentId: request.segmentId,
      episodeId: manifest.episode.episodeId,
      actor,
      take: request.take,
      reason: request.reason,
      ...(request.rejectedAuthorizationId === undefined
        ? {}
        : { rejectedAuthorizationId: request.rejectedAuthorizationId }),
    });

    return ok({
      runId: request.plan.runId,
      planId: request.plan.planId,
      segmentId: request.segmentId,
      take,
      adapterId: "none",
    });
  }

  /**
   * Attach a human's judgement to a take (contract §13.3, §15).
   *
   * §13.3 keeps final performance approval human-owned. A take is decided once; changing one's
   * mind is a new take superseding it, which is also what keeps the rejected take §15.1 requires
   * retained.
   */
  async decideTake(request: {
    runId: string;
    takeId: string;
    decision: TakeDecision;
    actor?: ActorRef;
  }): Promise<ServiceResult<TakeDecisionReport>> {
    // The actor is used, not merely demanded. It was validated here and then dropped, leaving the
    // ledger to fabricate `kind: "human"` for the trace — a fact this layer held and the next one
    // had to invent (#64, and the same shape as #67).
    const decidedBy = requireActor(request.actor ?? this.#context.actor, "decide take");
    const manifest = await this.#requireRun(request.runId);
    const take = await this.#context
      .ledgerFor()
      .decideTake(
        request.runId,
        request.takeId,
        request.decision,
        manifest.episode.episodeId,
        decidedBy,
      );
    return ok({ runId: request.runId, take });
  }

  /**
   * Takes recorded for a Run, with their lineage (contract §15, §15.1).
   *
   * Read-only, so no actor. Rejected takes are present by design: §15.1 requires them retained,
   * because a rejected take is evidence of what was tried and the input to a repair decision.
   */
  async takes(runId: string): Promise<ServiceResult<TakeReport>> {
    await this.#requireRun(runId);
    const ledger = this.#context.ledgerFor();
    const takes = await ledger.listTakes(runId);
    const lineage = [...(await ledger.lineage(runId)).values()];
    return ok({
      runId,
      takes,
      lineage,
      // Segments that have been synthesised and not yet judged. A segment that was planned but
      // never attempted is not "awaiting acceptance" — it is awaiting synthesis, which is a
      // different situation with a different next action.
      awaitingAcceptance: segmentsAwaitingAcceptance(
        takes,
        lineage.map((entry) => entry.segmentId),
      ),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Mutating operations
  // ---------------------------------------------------------------------------------------------

  /**
   * Run a stage (contract §11).
   *
   * Returns `unsuccessful` rather than throwing when the stage fails, is cancelled, or halts at a
   * gate: those are recorded outcomes an operator acts on (§20), and forcing a caller into
   * try/catch to read a gate halt would make the ordinary path the exceptional one.
   */
  async runStage(request: RunStageRequest): Promise<ServiceResult<StageRunReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, "run");
    const manifest = await this.#requireRun(request.runId);
    const runner = this.#context.runnerFor(actor);

    // §11 requires a stage to stop at its required gates, and recording `waiting_for_gate` after
    // the fact is not stopping. `@aldus-runtime/stage-runner` genuinely cannot check this — it
    // does not depend on the gate engine, deliberately — but this layer holds the engine, the
    // subjects provider, and the workflow graph, so the check belongs here (ADR-0015, ADR-0024).
    //
    // Only a gate the stage *declared* refuses. ADR-0021's conservative fallback — every blocking
    // gate blocks an undeclared stage — is right for the next-action display and would be a
    // deadlock here: every gate is unsatisfied when a Run starts, and the subjects those gates
    // bind are produced by the very stages that would be refused (ADR-0024).
    //
    // An unmet *predecessor* refuses unconditionally, and that asymmetry is deliberate: an edge
    // is declared rather than guessed, and it clears by running the predecessor, which is always
    // possible because a graph with no runnable entry point is a cycle and was refused when the
    // graph was resolved (ADR-0028).
    const blocker = enforcedBlockerFor(
      request.stageId,
      await this.#policyInput(request.runId, manifest, runner),
    );
    if (blocker !== undefined) {
      // A gate with no subjects at all is not merely undecided — it is *undecidable*, and
      // telling an operator to decide it is advice they cannot act on. Distinguishing the two is
      // the same separation ADR-0024 made between "decide this gate" and "I cannot tell whether
      // this gate applies", one layer further in.
      //
      // The most common cause is a gate binding an artifact that does not exist yet, which is
      // ordinary early in a Run. The case worth naming is when the stage being refused is what
      // *produces* those subjects: then the gate needs the artifact, the artifact needs the
      // stage, and the stage needs the gate. Aldus cannot prove that — what a gate binds is
      // adopter process supplied through a `SubjectsProvider` (§4.2), so nothing relates a
      // subject to its producer — but naming the possibility costs one line and is the only
      // clue an operator gets.
      const undecidable =
        blocker.kind === "gate" && blocker.gateId !== undefined
          ? ((await this.#context.subjectsFor(request.runId))[blocker.gateId] ?? []).length === 0
          : false;

      return refused({
        reason: blocker.kind === "ordering" ? "stage_predecessor_unmet" : "stage_gate_unsatisfied",
        explanation: undecidable
          ? `${blocker.reason} Nothing has supplied the values gate "${blocker.gateId}" binds, ` +
            "so it cannot be decided yet — something must produce them first. If this stage is " +
            "what produces them, it is gated on its own output and the gate belongs on the stage " +
            "that consumes it."
          : blocker.reason,
        details: {
          runId: request.runId,
          stageId: request.stageId,
          ...(blocker.gateId !== undefined ? { gateId: blocker.gateId } : {}),
          ...(blocker.after !== undefined ? { after: blocker.after } : {}),
          ...(undecidable ? { gateUndecidable: true } : {}),
        },
      });
    }

    const result: StageRunResult = await runner.run(request.runId, request.stageId, request.input, {
      ...(request.stageVersion !== undefined ? { stageVersion: request.stageVersion } : {}),
      ...(request.configuration !== undefined ? { configuration: request.configuration } : {}),
      ...(request.inputArtifacts !== undefined ? { inputArtifacts: request.inputArtifacts } : {}),
      ...(request.force !== undefined ? { force: request.force } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    const report: StageRunReport = {
      runId: request.runId,
      stageId: request.stageId,
      status: result.status,
      attemptId: result.attemptId,
      attempt: result.attempt,
      ...(result.gateId !== undefined ? { gateId: result.gateId } : {}),
      outputArtifacts: result.outputArtifacts,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };

    if (result.status === "succeeded") return ok(report);
    return unsuccessful(report, explainStageOutcome(result), result.error);
  }

  /**
   * Re-attempt a stage (contract §6.3, §19.1).
   *
   * Identical to {@link AldusServices.runStage} by design: §6.3 makes attempts append-only, so a
   * retry *is* another run. A separate code path would be a second place for the append-only rule
   * to be got wrong.
   */
  retryStage(request: RunStageRequest): Promise<ServiceResult<StageRunReport>> {
    return this.runStage(request);
  }

  /** Record an approval (contract §3.6, §13). */
  approve(request: GateDecisionRequest): Promise<ServiceResult<GateDecisionReport>> {
    return this.#decide(request, "approved");
  }

  /** Record a rejection (contract §3.6, §13). */
  reject(request: GateDecisionRequest): Promise<ServiceResult<GateDecisionReport>> {
    return this.#decide(request, "rejected");
  }

  /** Record a request for changes (contract §13). */
  requestChanges(request: GateDecisionRequest): Promise<ServiceResult<GateDecisionReport>> {
    return this.#decide(request, "changes_requested");
  }

  /**
   * Resolve an unresolved charge a human has adjudicated (#155 step 5, #215).
   *
   * `SpendService.reconcile` has done this since the reservation protocol landed and **nothing
   * could reach it**. A reservation left `billing_unknown` therefore made a Run terminal: the only
   * exit was `cancel`, which discards approvals and artifacts because both are Run-scoped. An
   * adopter lost two `human_oracle` decisions and $12.57 of settled work to a bookkeeping state
   * whose true amount was zero and whose own error said `Nothing was spawned`.
   *
   * `transcribing` mirrors {@link GateDecisionRequest}: the named person is the decider, the
   * **acting** actor is the transcriber, and the transcriber is derived rather than accepted.
   * Nothing authenticates either — what changes is that the record can tell them apart.
   *
   * Human-only and evidence-required, and neither is re-decided here.
   */
  async settleSpend(request: {
    runId: string;
    reservationId: string;
    resolution: ReconciliationResolution;
    evidenceRef: string;
    decisionId?: string;
    transcribing?: { decidedBy: ActorRef; verbatim: string };
    actor?: ActorRef;
  }): Promise<ServiceResult<{ reservationId: string; status: string; costIds: string[] }>> {
    const acting = requireActor(request.actor ?? this.#context.actor, "settle");
    const decider = request.transcribing?.decidedBy ?? acting;

    const known = await this.#context.spendStatus(request.runId);
    const found = known.find((entry) => entry.reservationId === request.reservationId);
    if (found === undefined) {
      return refused({
        reason: "reservation_not_found",
        explanation:
          `Run "${request.runId}" holds no reservation "${request.reservationId}". ` +
          "`aldus costs` lists the ones it does, and which are unresolved.",
        details: { runId: request.runId, reservationId: request.reservationId },
      });
    }

    const reservation = await this.#context.readReservation(found.grantId, found.reservationId);
    const settled = await this.#context.operatorConsole(decider).reconcile(reservation, {
      evidenceRef: request.evidenceRef,
      resolution: request.resolution,
      decisionId: request.decisionId ?? `settle:${request.reservationId}`,
      ...(request.transcribing === undefined
        ? {}
        : { transcription: { recordedBy: acting, verbatim: request.transcribing.verbatim } }),
    });

    return ok({
      reservationId: settled.reservation.reservationId,
      status: settled.reservation.status,
      costIds: settled.costs.map((record) => record.costId),
    });
  }

  /**
   * Record that a dispatch is not coming back, so its reservation can be reconciled (#226).
   *
   * A process killed between `reserve` and any billing outcome leaves the reservation `reserved`.
   * Nothing survived to classify it, so it never became `billing_unknown` — and `settleSpend`
   * accepts only `billing_unknown`. The first adopter hit exactly this: `aldus costs` listed a
   * reservation holding $12.00 and named `costs settle` as the resolution, and `settle` refused it.
   * **The one place that tells an operator what to do named the one command that would refuse
   * them.**
   *
   * What this records is that a person decided the dispatch is not coming back. It records
   * **unknown, not zero**: the execution may have run for minutes before it was killed, so
   * releasing it as uncharged would be a lie, and no amount is knowable from here. The reservation
   * keeps consuming its full authorization until a reconciliation resolves it — which is the
   * conservative direction and the point of ADR-0044.
   *
   * `reason` is required. A reservation moved out of `reserved` with no stated reason is
   * indistinguishable from one the runtime classified itself.
   */
  async abandonDispatch(request: {
    runId: string;
    reservationId: string;
    reason: string;
    transcribing?: { decidedBy: ActorRef; verbatim: string };
    actor?: ActorRef;
  }): Promise<ServiceResult<{ reservationId: string; status: string }>> {
    const acting = requireActor(request.actor ?? this.#context.actor, "abandon");
    const decider = request.transcribing?.decidedBy ?? acting;

    if (request.reason.trim() === "") {
      return refused({
        reason: "reason_required",
        explanation:
          "Abandoning a dispatch needs a reason: it records a person's judgement that an " +
          "execution is not coming back, and without one the record cannot be told from a " +
          "billing outcome the runtime classified itself.",
        details: { reservationId: request.reservationId },
      });
    }

    const known = await this.#context.spendStatus(request.runId);
    const found = known.find((entry) => entry.reservationId === request.reservationId);
    if (found === undefined) {
      return refused({
        reason: "reservation_not_found",
        explanation:
          `Run "${request.runId}" holds no reservation "${request.reservationId}". ` +
          "`aldus costs` lists the ones it does, and which are unresolved.",
        details: { runId: request.runId, reservationId: request.reservationId },
      });
    }

    // Only a stuck reservation. `billing_unknown` is already unresolved and goes to `settle`; a
    // settled or released one is terminal. Refusing here rather than in the store keeps the
    // operator's error next to the operator's verb.
    if (found.status !== "reserved") {
      return refused({
        reason: "reservation_not_stuck",
        explanation:
          `Reservation "${request.reservationId}" is "${found.status}", not "reserved". ` +
          (found.status === "billing_unknown"
            ? "Its billing outcome is already unresolved — `aldus costs settle` is the verb for it."
            : "It is terminal: a reservation that stopped consuming authorization never resumes " +
              "(ADR-0044)."),
        details: { reservationId: request.reservationId, status: found.status },
      });
    }

    const reservation = await this.#context.readReservation(found.grantId, found.reservationId);
    const marked = await this.#context.operatorConsole(decider).abandonDispatch(reservation, {
      reason: request.reason,
      ...(request.transcribing === undefined
        ? {}
        : { transcription: { recordedBy: acting, verbatim: request.transcribing.verbatim } }),
    });

    return ok({ reservationId: marked.reservationId, status: marked.status });
  }

  /**
   * Record a waiver — the check was **bypassed**, not passed (contract §13).
   *
   * `waived` has been a first-class decision since §13 was written: attributable, dated,
   * subject-binding, and voided when its subjects drift. What was missing was a door to it, so an
   * operator who could not honestly approve a gate had only two shapes available — widen
   * `permittedActorKinds`, or approve something they did not judge — and both record a decision
   * that misdescribes what happened.
   *
   * `reason` is required, and the engine refuses a non-expiring waiver. Neither rule lives here:
   * the engine owns §13, and a copy of the rule beside it is a second place to get it wrong.
   */
  waive(request: GateWaiverRequest): Promise<ServiceResult<GateDecisionReport>> {
    return this.#decide({ ...request, comment: request.reason }, "waived");
  }

  /**
   * Record a decision through the gate engine (contract §3.6, §13).
   *
   * The engine owns every rule here — which actors may decide (§13.3), what a decision must bind
   * (§13.2), and what the decision invalidates downstream (§13.1). These services only supply the
   * actor, the timestamp, and the current subjects, because re-deciding any of that here would
   * put a second, divergent copy of §13 in the codebase.
   */
  async #decide(
    request: GateDecisionRequest,
    decision: "approved" | "rejected" | "changes_requested" | "waived",
  ): Promise<ServiceResult<GateDecisionReport>> {
    const acting = requireActor(request.actor ?? this.#context.actor, decision);

    // Who decided, and — where those differ — who wrote it down. `recordedBy` is the **acting**
    // actor and is never taken from the request: the caller says whose decision this is, and the
    // runtime says who is recording it, so a transcriber cannot omit or rename itself.
    const actor = request.transcribing?.decidedBy ?? acting;
    const transcription =
      request.transcribing === undefined
        ? undefined
        : { recordedBy: acting, verbatim: request.transcribing.verbatim };
    const manifest = await this.#requireRun(request.runId);
    const subjects = await this.#context.subjectsFor(request.runId);
    const gateSubjects = subjects[request.gateId] ?? [];

    const recorded = await this.#context.gates.decide({
      runId: request.runId,
      gateId: request.gateId,
      decision,
      subjects: gateSubjects,
      decidedBy: actor,
      decidedAt: this.#context.now().toISOString(),
      episodeId: manifest.episode.episodeId,
      ...(request.comment !== undefined ? { comment: request.comment } : {}),
      ...(transcription === undefined ? {} : { transcription }),
      ...(request.expiresOnChange !== undefined
        ? { expiresOnChange: request.expiresOnChange }
        : {}),
    });

    const gates = await this.#gateStatuses(request.runId);
    return ok({
      runId: request.runId,
      gateId: request.gateId,
      decisionId: recorded.decisionId,
      decision: recorded.decision,
      gates,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  /**
   * Refuse a bundle naming a destination nothing can serve (contract §17, ADR-0015).
   *
   * Throws rather than refusing: a missing adapter is a wiring error the adopter must fix, and no
   * approval an operator could grant would make it appear. Checked up front so a bundle does not
   * half-execute before discovering its last operation has nowhere to go.
   */
  #requireReleaseAdapters(bundle: ReleaseBundle): void {
    const missing = [
      ...new Set(
        operationsOf(bundle)
          .map((operation) => operation.destination)
          .filter((destination) => this.#context.releaseAdapters.find(destination) === undefined),
      ),
    ];
    if (missing.length === 0) return;
    throw serviceError(
      ServiceErrorCodes.ADAPTER_NOT_WIRED,
      `No release adapter is wired for ${missing.map((name) => `"${name}"`).join(", ")}. Aldus ` +
        "names no publishing platform (contract §4.2); an adopter integration supplies the " +
        "adapter for each destination (§4.3).",
      // See the note at the synthesis throw site: a missing adapter is a wiring error, and no
      // approval makes one appear.
      {
        category: "validation",
        retryable: false,
        details: { runId: bundle.runId, destinations: missing },
      },
    );
  }

  /**
   * Map a release refusal onto a `refused` result.
   *
   * `@aldus-runtime/release` throws for an unheld authority (§13.4) and for an unconfirmed outcome that
   * cannot be reconciled (§17). Both are policy answers, not malfunctions: §18's contract is that
   * "not permitted right now" is an ordinary reply, and letting them surface as exceptions would
   * force every adapter into try/catch to learn something it needs to display.
   */
  async #releaseAttempt<T>(
    runId: string,
    attempt: () => Promise<ServiceResult<T>>,
  ): Promise<ServiceResult<T>> {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof AldusError)) throw error;
      if (error.category !== "policy" && error.category !== "conflict") throw error;
      return refused({
        reason: error.code,
        explanation: error.message,
        details: { runId, ...(error.details ?? {}) },
      });
    }
  }

  /**
   * What each declared rework policy would do next, and why (#220 criterion 7).
   *
   * Read-only. Nothing here runs a repair, spends anything, or writes a record — it derives the
   * rounds from what already happened and asks {@link decideRework} what follows. Criterion 7 wants
   * an operator to see the current round, why another is allowed, and why the loop stopped; this is
   * that, and it deliberately ships before the half that acts.
   *
   * A policy whose evaluating stage has never run reports no decision rather than a default. "The
   * loop has not started" and "the loop converged" produce the same empty round list, and the
   * distinction is the one `not_evaluated` exists to keep.
   */
  async reworkStatus(runId: string): Promise<ServiceResult<ReworkStatusReport>> {
    await this.#requireRun(runId);
    const runner = this.#context.runnerFor(this.#actorOrSystem());
    const state = await runner.stageState(runId);

    const attemptsOf = (stageId: string): AttemptWithMetadata[] => {
      const stored = state.stages.find((entry) => entry.execution.stageId === stageId);
      if (stored === undefined) return [];
      return stored.execution.attempts.map((attempt) => {
        const metadata = stored.metadata[attempt.attemptId];
        return {
          attempt,
          ...(metadata?.blockingFindingClasses === undefined
            ? {}
            : { blockingFindingClasses: metadata.blockingFindingClasses }),
          ...(metadata?.evaluationEvidence === undefined
            ? {}
            : {
                enumeratedFindings: metadata.evaluationEvidence.enumeratedFindings,
                defectCountMeasurable: metadata.evaluationEvidence.defectCountMeasurable,
              }),
        };
      });
    };

    const loops = this.#context.reworkPolicies.map((policy) => {
      const evaluationAttempts = attemptsOf(policy.stageId);
      const repairAttempts = attemptsOf(policy.repairStageId);
      const rounds = deriveReworkRounds({ runId, policy, evaluationAttempts, repairAttempts });
      const latest = evaluationAttempts.at(-1);

      // No evaluation attempt at all is not an empty evaluation. Reporting a decision here would
      // answer a question nobody has asked yet, and `converged` is the answer it would give.
      if (latest === undefined) {
        return { policyId: policy.policyId, stageId: policy.stageId, rounds, spent: rounds.length };
      }

      const digest = latest.attempt.outputArtifacts.at(-1)?.sha256;
      const verdict: ReworkVerdict =
        digest === undefined || latest.blockingFindingClasses === undefined
          ? {
              kind: "not_evaluated",
              artifactDigest: digest ?? "",
              reason:
                digest === undefined
                  ? `attempt ${latest.attempt.attemptId} of "${policy.stageId}" registered no artifact to judge`
                  : `attempt ${latest.attempt.attemptId} of "${policy.stageId}" recorded no evaluation`,
            }
          : {
              kind: "evaluated",
              artifactDigest: digest,
              blockingFindingClasses: latest.blockingFindingClasses,
              observedFindingClasses: latest.blockingFindingClasses,
              ...(latest.defectCountMeasurable === true && latest.enumeratedFindings !== undefined
                ? { findingCount: latest.enumeratedFindings }
                : {}),
            };

      return {
        policyId: policy.policyId,
        stageId: policy.stageId,
        rounds,
        spent: rounds.length,
        decision: decideRework({
          policy,
          rounds,
          verdict,
          fallbackGateId: policy.escalateToGateId,
        }),
      };
    });

    return ok({ runId, loops });
  }

  /** The actor to attribute reads to, when none was configured. */
  #actorOrSystem(): ActorRef {
    return this.#context.actor ?? { kind: "system", id: "aldus-services" };
  }

  /** Derive one Run's state from its stage executions (ADR-0026). */
  async #runState(runId: string, manifest: RunManifest, runner: StageRunner): Promise<RunState> {
    const state = await runner.stageState(runId);
    const stages = this.#stageReports(state.stages).map((report) =>
      toSnapshot(
        report,
        this.#context.requiredGatesFor(report.stageId),
        this.#context.predecessorsFor(report.stageId),
      ),
    );
    return deriveRunState(manifest, stages, this.#context.workflow);
  }

  /** Load a Run or fail with a clear cause. */
  async #requireRun(runId: string): Promise<RunManifest> {
    const manifest = await this.#context.workspace.runs.get(runId);
    if (manifest === undefined) {
      throw serviceError(
        ServiceErrorCodes.RUN_NOT_FOUND,
        `Run "${runId}" does not exist in this workspace.`,
        { category: "not_found", details: { runId } },
      );
    }
    return manifest;
  }

  /** Evaluate every gate for a Run against the caller-supplied subjects. */
  async #gateStatuses(runId: string): Promise<GateStatus[]> {
    const subjects = await this.#context.subjectsFor(runId);
    const statuses = await this.#context.gates.evaluate(runId, subjects);
    return [...statuses.values()];
  }

  /**
   * The policy's view of a Run.
   *
   * Assembled in one place because two callers depend on it agreeing: `status` renders the plan,
   * and `runStage` refuses on it. If each built its own view, the two could drift apart — which
   * is the defect ADR-0024 fixes, reintroduced one level up.
   */
  async #policyInput(
    runId: string,
    manifest: RunManifest,
    runner: StageRunner,
  ): Promise<ActionPolicyInput> {
    const gates = await this.#gateStatuses(runId);
    const state = await runner.stageState(runId);
    const stages = this.#stageReports(state.stages);
    // The money, which this input never carried. A stage blocked by an unresolved charge was
    // offered as runnable because the plan knew about gates and stages and nothing else (#215).
    const unresolvedSpend = (await this.#context.spendStatus(runId))
      .filter((entry) => entry.requiresReconciliation)
      .map((entry) => ({ reservationId: entry.reservationId, operation: entry.operation }));
    return {
      ...(unresolvedSpend.length > 0 ? { unresolvedSpend } : {}),
      // The derived status, not the stored one. `decideActions` already knows what to say about
      // a cancelled or completed Run; before ADR-0026 it simply never received either.
      run: {
        runId: manifest.runId,
        status: deriveRunState(manifest, stages, this.#context.workflow).status,
      },
      // Required gates are resolved here rather than inside the policy, so `decideActions` stays
      // a pure function of state and the workflow graph stays a caller concern (ADR-0021).
      stages: stages.map((report) =>
        toSnapshot(
          report,
          this.#context.requiredGatesFor(report.stageId),
          this.#context.predecessorsFor(report.stageId),
        ),
      ),
      gates,
    };
  }

  /** Assemble the full picture of one Run, including what to do next. */
  async #runReport(runId: string): Promise<RunReport> {
    const manifest = await this.#requireRun(runId);
    const costRecords = await this.#context.workspace.runs.listRecords(runId, "costs");

    const runner = this.#context.runnerFor(
      this.#context.actor ?? { kind: "system", id: "aldus-services" },
    );
    const input = await this.#policyInput(runId, manifest, runner);
    const state = await runner.stageState(runId);
    const stages = this.#stageReports(state.stages);

    return {
      run: manifest,
      state: deriveRunState(manifest, input.stages, this.#context.workflow),
      stages,
      gates: input.gates as GateStatus[],
      costs: summariseCosts(costRecords),
      plan: decideActions(input),
    };
  }

  /**
   * Merge what has run with what is registered.
   *
   * Both directions matter. A registered stage with no execution is the ordinary "not started
   * yet" case. An execution whose definition is no longer registered is reported with
   * `registered: false` rather than dropped — §20 requires production trace to answer what
   * happened, and silently omitting a stage because the code moved on would lose exactly that.
   */
  #stageReports(stored: readonly StoredStageExecution[]): StageReport[] {
    const reports: StageReport[] = [];
    const seen = new Set<string>();

    for (const entry of stored) {
      const execution = entry.execution;
      const latest = execution.attempts[execution.attempts.length - 1];
      const haltedAt = gateIdOf(entry);
      seen.add(execution.stageId);
      reports.push({
        stageId: execution.stageId,
        status: execution.status,
        versions: this.#context.stageRegistry.versionsOf(execution.stageId),
        registered: this.#context.stageRegistry.versionsOf(execution.stageId).length > 0,
        ...(latest?.attempt !== undefined ? { attempt: latest.attempt } : {}),
        ...(latest?.error !== undefined
          ? { error: latest.error, retryable: latest.error.retryable }
          : {}),
        ...(execution.startedAt !== undefined ? { startedAt: execution.startedAt } : {}),
        ...(execution.finishedAt !== undefined ? { finishedAt: execution.finishedAt } : {}),
        ...(haltedAt !== undefined ? { gateId: haltedAt } : {}),
      });
    }

    for (const stageId of this.#context.stageRegistry.ids()) {
      if (seen.has(stageId)) continue;
      reports.push({
        stageId,
        status: "never_run",
        versions: this.#context.stageRegistry.versionsOf(stageId),
        registered: true,
      });
    }

    reports.sort((a, b) => a.stageId.localeCompare(b.stageId));
    return reports;
  }
}

/** The gate a stage halted at, read from its latest attempt's metadata. */
function gateIdOf(entry: StoredStageExecution): string | undefined {
  const attempts = entry.execution.attempts;
  const latest = attempts[attempts.length - 1];
  if (latest === undefined) return undefined;
  return entry.metadata[latest.attemptId]?.gateId;
}

/** Narrow a full report to what the action policy reads. */
function toSnapshot(
  report: StageReport,
  requiredGates: readonly string[] | undefined,
  after: readonly string[] = [],
): StageSnapshot {
  return {
    stageId: report.stageId,
    status: report.status as StageSummaryStatus,
    ...(report.gateId !== undefined ? { gateId: report.gateId } : {}),
    ...(report.retryable !== undefined ? { retryable: report.retryable } : {}),
    ...(report.attempt !== undefined ? { attempt: report.attempt } : {}),
    // Absent stays absent: the policy distinguishes "declared none" from "not declared".
    ...(requiredGates !== undefined ? { requiredGates } : {}),
    // Empty is omitted rather than passed through — for edges the two mean the same thing, and
    // omitting keeps a snapshot of a graph-less workflow identical to what it was before ADR-0028.
    ...(after.length > 0 ? { after } : {}),
  };
}

/**
 * Reduce a manifest to a list entry, reporting its **derived** state.
 *
 * A list is exactly where the stored status misled worst: a directory of Runs all reading
 * `created` gives an operator no way to tell finished work from untouched work (ADR-0026).
 */
function toSummary(manifest: RunManifest, state: RunState): RunSummary {
  return {
    runId: manifest.runId,
    status: state.status,
    workflowId: manifest.workflowId,
    workflowVersion: manifest.workflowVersion,
    ...(state.currentStage !== undefined ? { currentStage: state.currentStage } : {}),
    ...(state.waitingOn.length > 0 ? { waitingOn: state.waitingOn } : {}),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

/** One sentence for a non-success stage outcome. */
function explainStageOutcome(result: StageRunResult): string {
  switch (result.status) {
    case "waiting_for_gate":
      return (
        `The stage stopped at gate "${result.gateId ?? "unknown"}" and is waiting for a ` +
        "decision (contract §11: a stage must stop at required gates)."
      );
    case "cancelled":
      return "The attempt was cancelled before it reached a terminal outcome.";
    case "failed":
      return result.error?.message ?? "The stage failed without recording a reason.";
    default:
      return "The stage did not succeed.";
  }
}

/**
 * One sentence for a non-success release outcome (contract §17).
 *
 * `pending` is called out separately from `failed` because they demand opposite responses: a
 * pending operation must be reconciled against the destination, and retrying it is how a double
 * publish happens.
 */
function explainReleaseOutcome(outcome: ReleaseOutcome): string {
  const remaining = outcome.status.remaining.join(", ");
  if (outcome.state === "pending") {
    return (
      `The release is incomplete because an operation's outcome was never confirmed (${remaining}). ` +
      "It must be reconciled against the destination rather than retried, since retrying " +
      "something that already succeeded would publish it twice."
    );
  }
  const warnings = outcome.warnings.length > 0 ? ` ${outcome.warnings.join(" ")}` : "";
  return `The release did not complete. Outstanding operations: ${remaining || "none"}.${warnings}`;
}

/** One sentence for the workspace as a whole. */
function workspaceSummary(
  episode: EpisodeRef | undefined,
  runs: readonly RunSummary[],
  focused: RunReport | undefined,
): string {
  if (episode === undefined) {
    return (
      "This workspace has no Episode yet. Create one with init before starting a Run " +
      "(contract §6.1)."
    );
  }
  if (runs.length === 0) {
    return `Episode "${episode.episodeId}" has no Runs yet. Start one to begin production.`;
  }
  if (focused !== undefined) return focused.plan.summary;
  return (
    `Episode "${episode.episodeId}" has ${runs.length} Runs. Name one to see its state and the ` +
    "next safe action."
  );
}
