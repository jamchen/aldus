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

import type { ActorRef, ArtifactRef, EpisodeRef, RunManifest } from "@aldus/core";
import {
  AldusError,
  SCHEMA_VERSION,
  formatEpisodeId,
  isCanonicalId,
  newRunId,
  validate,
} from "@aldus/core";
import { isArchived, type ArtifactRecord } from "@aldus/artifact-registry";
import { initWorkspace } from "@aldus/file-store";
import type { GateStatus } from "@aldus/gate-engine";
import { operationsOf, type ReleaseBundle, type ReleaseOutcome } from "@aldus/release";
import type { StageRunResult, StoredStageExecution } from "@aldus/stage-runner";
import { segmentsAwaitingAcceptance } from "@aldus/tts-ledger";
import type {
  PerformanceScript,
  RecordTakeInput,
  TakeDecision,
  TtsRequestPlan,
} from "@aldus/tts-ledger";

import { requireActor } from "./actor.js";
import type { AldusContext } from "./context.js";
import { summariseCosts } from "./costs.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";
import { decideActions, type StageSnapshot, type StageSummaryStatus } from "./nextaction.js";
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
  StatusReport,
  SynthesisReport,
  TakeDecisionReport,
  TakeReport,
} from "./reports.js";
import { ok, refused, unsuccessful, type ServiceResult } from "./results.js";

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
  /** Overrides the gate definition's default. */
  expiresOnChange?: boolean;
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

    const timestamp = this.#context.now().toISOString();
    const manifest: RunManifest = {
      schemaVersion: SCHEMA_VERSION,
      runId: request.runId ?? newRunId(),
      episode,
      workflowId: request.workflowId,
      workflowVersion: request.workflowVersion,
      status: "created",
      ...(request.codeRevision !== undefined ? { codeRevision: request.codeRevision } : {}),
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

    for (const id of runIds) {
      const manifest = await this.#context.workspace.runs.get(id);
      if (manifest !== undefined) summaries.push(toSummary(manifest));
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
    return ok({ runId, records, summary: summariseCosts(records) });
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
   * `@aldus/release` exposes that switch so its own tests can demonstrate the duplicate publish it
   * prevents; exposing it here would make double-publishing a caller's option, and ADR-0015 places
   * policy on Aldus's side of the injection point. An adapter that cannot be queried is refused
   * rather than retried.
   *
   * Authority comes from `@aldus/gate-engine` and is never re-decided here: §13.4 keeps uploading
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
        { category: "policy", details: { runId: request.plan.runId } },
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
    requireActor(request.actor ?? this.#context.actor, "decide take");
    const manifest = await this.#requireRun(request.runId);
    const take = await this.#context
      .ledgerFor()
      .decideTake(request.runId, request.takeId, request.decision, manifest.episode.episodeId);
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
    await this.#requireRun(request.runId);

    const runner = this.#context.runnerFor(actor);
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
   * Record a decision through the gate engine (contract §3.6, §13).
   *
   * The engine owns every rule here — which actors may decide (§13.3), what a decision must bind
   * (§13.2), and what the decision invalidates downstream (§13.1). These services only supply the
   * actor, the timestamp, and the current subjects, because re-deciding any of that here would
   * put a second, divergent copy of §13 in the codebase.
   */
  async #decide(
    request: GateDecisionRequest,
    decision: "approved" | "rejected" | "changes_requested",
  ): Promise<ServiceResult<GateDecisionReport>> {
    const actor = requireActor(request.actor ?? this.#context.actor, decision);
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
      { category: "policy", details: { runId: bundle.runId, destinations: missing } },
    );
  }

  /**
   * Map a release refusal onto a `refused` result.
   *
   * `@aldus/release` throws for an unheld authority (§13.4) and for an unconfirmed outcome that
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

  /** Assemble the full picture of one Run, including what to do next. */
  async #runReport(runId: string): Promise<RunReport> {
    const manifest = await this.#requireRun(runId);
    const gates = await this.#gateStatuses(runId);
    const costRecords = await this.#context.workspace.runs.listRecords(runId, "costs");

    const runner = this.#context.runnerFor(
      this.#context.actor ?? { kind: "system", id: "aldus-services" },
    );
    const state = await runner.stageState(runId);
    const stages = this.#stageReports(state.stages);

    const plan = decideActions({
      run: { runId: manifest.runId, status: manifest.status },
      stages: stages.map(toSnapshot),
      gates,
    });

    return { run: manifest, stages, gates, costs: summariseCosts(costRecords), plan };
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
function toSnapshot(report: StageReport): StageSnapshot {
  return {
    stageId: report.stageId,
    status: report.status as StageSummaryStatus,
    ...(report.gateId !== undefined ? { gateId: report.gateId } : {}),
    ...(report.retryable !== undefined ? { retryable: report.retryable } : {}),
    ...(report.attempt !== undefined ? { attempt: report.attempt } : {}),
  };
}

/** Reduce a manifest to a list entry. */
function toSummary(manifest: RunManifest): RunSummary {
  return {
    runId: manifest.runId,
    status: manifest.status,
    workflowId: manifest.workflowId,
    workflowVersion: manifest.workflowVersion,
    ...(manifest.currentStage !== undefined ? { currentStage: manifest.currentStage } : {}),
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
