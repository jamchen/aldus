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
import { SCHEMA_VERSION, formatEpisodeId, isCanonicalId, newRunId, validate } from "@aldus/core";
import { initWorkspace } from "@aldus/file-store";
import type { GateStatus } from "@aldus/gate-engine";
import type { StageRunResult, StoredStageExecution } from "@aldus/stage-runner";

import { requireActor } from "./actor.js";
import type { AldusContext } from "./context.js";
import { summariseCosts } from "./costs.js";
import { ServiceErrorCodes, serviceError } from "./errors.js";
import { decideActions, type StageSnapshot, type StageSummaryStatus } from "./nextaction.js";
import type {
  ArtifactReport,
  CostReport,
  EpisodeInspection,
  GateDecisionReport,
  InitReport,
  Inspection,
  ReleaseReport,
  RunInspection,
  RunReport,
  RunSummary,
  StageReport,
  StageRunReport,
  StartRunReport,
  StatusReport,
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

  /** Artifacts recorded against a Run (contract §8). */
  async artifacts(runId: string): Promise<ServiceResult<ArtifactReport>> {
    await this.#requireRun(runId);
    const artifacts = await this.#context.workspace.runs.listRecords(runId, "artifacts");
    return ok({ runId, artifacts });
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
