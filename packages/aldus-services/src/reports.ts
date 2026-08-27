/**
 * The structured shapes services return.
 *
 * Kept in one module because these are the package's public contract with its adapters: the CLI
 * renders them, the Production MCP (WP-11) serialises them, and neither may add a field the
 * other cannot see. Contract §18 makes both adapters over the same services, and a shape defined
 * inside one service's file drifts into being that service's private business.
 */

import type { ReservationStatus } from "./spend-service.js";
import type {
  ArtifactRef,
  CostRecord,
  EpisodeRef,
  ReleaseReceipt,
  RunManifest,
  StructuredError,
} from "@aldus-runtime/core";
import type {
  ArtifactRecord,
  CleanupBlock,
  LineageEdge,
  LineageResult,
  ProducerInfo,
} from "@aldus-runtime/artifact-registry";
import type { GateStatus } from "@aldus-runtime/gate-engine";
import type { ReworkDecision } from "./rework.js";
import type { ReworkRound } from "@aldus-runtime/core";
import type { BundleStatus, ReconciliationReport, ReleaseOutcome } from "@aldus-runtime/release";
import type {
  PerformanceScript,
  SegmentLineage,
  TakeRecord,
  TtsRequestPlan,
} from "@aldus-runtime/tts-ledger";

import type { ActionPlan, StageSnapshot } from "./nextaction.js";
import type { RunState } from "./runstate.js";

/** One stage's current situation (contract §6.3). */
export interface StageReport extends StageSnapshot {
  /** Versions registered for this stage id, if it is registered at all. */
  versions: string[];
  /** True when the runtime knows a definition for it; false when only a record survives. */
  registered: boolean;
  /** When the latest attempt started, if it has run. */
  startedAt?: string;
  /** When the latest attempt reached a terminal state. */
  finishedAt?: string;
  /** The recorded failure of the latest attempt, already redacted. */
  error?: StructuredError;
}

/** Money totals for a Run, by currency (contract §19.3). */
export interface CostSummary {
  /** Number of cost records. */
  recordCount: number;
  /** Actual charges, summed per ISO-4217 currency. */
  actualByCurrency: Record<string, string>;
  /** Estimates, summed per currency, for records with no actual charge yet. */
  estimatedByCurrency: Record<string, string>;
  /**
   * Currencies holding at least one record whose billing status is `unknown`.
   *
   * Surfaced rather than folded into a total: §19.3 requires "safe handling of unknown provider
   * billing status", and a total that silently includes unconfirmed charges reads as settled.
   */
  currenciesWithUnknownBilling: string[];
  /**
   * How many records carry `billingStatus: "unknown"` (§19.3; #150).
   *
   * **Do not read `currenciesWithUnknownBilling` as the only unknown-billing signal.** A charge
   * whose amount nobody knows has no `Money` to derive a currency from, so it cannot appear there
   * — and an empty list would then read as "no unconfirmed billing" when a real charge stands.
   */
  unknownBillingRecordCount: number;
  /**
   * Of those, how many state no amount at all.
   *
   * These add nothing to `actualByCurrency` or `estimatedByCurrency`, because there is nothing to
   * add and a fabricated zero would be a numerical assertion where the truth is an uncertainty
   * state. Their consequence is that **settled totals may be understated**, and a reader must be
   * told so rather than left to infer it from a count.
   */
  unquantifiedUnknownBillingRecordCount: number;
}

/** A Run's full situation (contract §24). */
export interface RunReport {
  /**
   * The manifest exactly as stored.
   *
   * Its `status` and `currentStage` record the Run as *created* and are never rewritten. Read
   * {@link RunReport.state} for where the Run is now (ADR-0026).
   */
  run: RunManifest;
  /** Where the Run is now, derived from its stages and its cancellation record (ADR-0026). */
  state: RunState;
  stages: StageReport[];
  gates: GateStatus[];
  costs: CostSummary;
  /** What is safe to do now, and why everything else is not. */
  plan: ActionPlan;
}

/** A Run reduced to what a list needs. */
export interface RunSummary {
  runId: string;
  /** The **derived** current status, not the one stored in the manifest (ADR-0026). */
  status: RunManifest["status"];
  workflowId: string;
  workflowVersion: string;
  /** Derived, like {@link RunSummary.status}. */
  currentStage?: string;
  /** Gates a `waiting` Run is held at, so a list does not force an operator to open each Run. */
  waitingOn?: readonly string[];
  createdAt: string;
  updatedAt: string;
}

/** What `status` answers (contract §18, §24). */
export interface StatusReport {
  /** Absolute path of the bound workspace (contract §19.2). */
  workspaceRoot: string;
  /** False when the workspace has no `.aldus` directory yet. */
  initialized: boolean;
  /** The Episode, when one has been created. */
  episode?: EpisodeRef;
  /** Every Run in the workspace, newest last. */
  runs: RunSummary[];
  /**
   * The Run this report focuses on.
   *
   * Chosen automatically when the workspace holds exactly one, so that the common case needs no
   * `--run` (§24: an operator should see the state without ceremony).
   */
  focused?: RunReport;
  /** One sentence for the workspace as a whole, present even when nothing is focused. */
  summary: string;
}

/** What `inspect` answers for a Run. */
export interface RunInspection {
  kind: "run";
  report: RunReport;
  artifacts: ArtifactRef[];
  approvals: number;
  releases: ReleaseReceipt[];
}

/** What `inspect` answers for an Episode. */
export interface EpisodeInspection {
  kind: "episode";
  episode: EpisodeRef;
  runs: RunSummary[];
}

/** `inspect` resolves its argument to one of these (contract §18). */
export type Inspection = RunInspection | EpisodeInspection;

/** Result of running or retrying a stage (contract §6.3, §11). */
export interface StageRunReport {
  runId: string;
  stageId: string;
  status: "succeeded" | "failed" | "waiting_for_gate" | "cancelled";
  attemptId: string;
  attempt: number;
  gateId?: string;
  outputArtifacts: ArtifactRef[];
  error?: StructuredError;
}

/** Result of recording a gate decision (contract §3.6, §13). */
export interface GateDecisionReport {
  runId: string;
  gateId: string;
  decisionId: string;
  decision: "approved" | "rejected" | "changes_requested" | "waived";
  /** Gate states after the decision, so a caller sees the cascade it caused (§13.1). */
  gates: GateStatus[];
}

/** Result of `init`. */
export interface InitReport {
  workspaceRoot: string;
  /** True when this call created the `.aldus` directory rather than finding it. */
  created: boolean;
  episode?: EpisodeRef;
}

/** Result of creating a Run. */
export interface StartRunReport {
  run: RunManifest;
}

/** Cost records with their summary (contract §19.3). */
export interface CostReport {
  runId: string;
  records: CostRecord[];
  summary: CostSummary;
  /**
   * Reservations still awaiting reconciliation (#215).
   *
   * Absent from this report until an adopter found out the hard way: `costs` read cost *records*
   * only, so an unresolved charge — which lives in the reservation store and blocks every later
   * dispatch on its grant — printed nothing at all. The command whose whole job is the money
   * showed six settled records and a total, as if nothing were pending, while the Run could not
   * proceed.
   *
   * Each carries the `reservationId` `aldus costs settle` takes, so the report names its own
   * remedy rather than leaving an operator to find one.
   */
  unresolved: ReservationStatus[];
}

/**
 * Artifacts recorded against a Run (contract §8, §8.1, §20).
 *
 * Registry-backed. The registry is the authoritative list (`@aldus-runtime/artifact-registry`), and §7's
 * per-run `artifacts.json` is a materialized view a stage runner maintains — so `records` carries
 * provenance and archival state that the collection cannot, and `artifacts` remains for callers
 * that only want the `ArtifactRef`s.
 */
export interface ArtifactReport {
  runId: string;
  /** Every registered artifact's `ArtifactRef`, in registry order. */
  artifacts: ArtifactRef[];
  /** The full records: provenance, archive receipt, supersession (contract §8.1). */
  records: ArtifactRecord[];
  /**
   * Artifacts present in §7's `artifacts.json` that the registry does not hold.
   *
   * Non-empty for a Run produced before the registry existed, or by a producer that wrote the
   * collection directly. Reported rather than merged: §3.4 makes durable records authoritative,
   * and quietly presenting an unregistered entry as registered would claim provenance and
   * archival state that were never collected.
   */
  unregistered: ArtifactRef[];
  /**
   * Registered irreplaceable artifacts with no verified archive receipt (contract §8.1).
   *
   * §8.1 requires these to be archived before disposable working files are cleaned, so an
   * operator needs to see them before planning any cleanup.
   */
  unarchivedIrreplaceable: ArtifactRecord[];
}

/** One artifact's place in the derivation graph (contract §20). */
export interface ArtifactLineageReport {
  artifactId: string;
  /** The record itself. */
  record: ArtifactRecord;
  /** Run, stage, code revision, and configuration digest that produced it (contract §8.1). */
  producer: ProducerInfo | undefined;
  /** Immediate declared inputs, one edge per digest. */
  inputs: LineageEdge[];
  /** Artifacts directly derived from it. */
  consumers: ArtifactRecord[];
  /** Everything it was transitively derived from, nearest first. */
  ancestors: LineageResult;
  /** Everything transitively derived from it, nearest first. */
  descendants: LineageResult;
}

/** What a cleanup would do, decided before anything is removed (contract §8.1). */
export interface CleanupPlanReport {
  runId: string;
  /** Artifacts whose working files may be removed. */
  removable: ArtifactRecord[];
  /** Artifacts that must not be removed, each with why. */
  blocked: CleanupBlock[];
  /** Candidate IDs the registry does not hold. */
  unknownArtifactIds: string[];
  /** True when nothing blocks the plan. */
  safe: boolean;
}

/** Result of archiving irreplaceable artifacts (contract §8.1). */
export interface ArchiveReport {
  runId: string;
  /** Records archived by this call. */
  archived: ArtifactRecord[];
  /** Records that already held a verified receipt. */
  alreadyArchived: ArtifactRecord[];
}

/** Result of executing a release bundle (contract §17). */
export interface ReleaseExecutionReport {
  runId: string;
  bundleId: string;
  outcome: ReleaseOutcome;
}

/** Result of reconciling a release bundle against its destinations (contract §17). */
export interface ReleaseReconciliationReport {
  runId: string;
  bundleId: string;
  report: ReconciliationReport;
}

/** A release bundle's derived state (contract §17, §19.1). */
export interface ReleaseBundleReport {
  runId: string;
  bundleId: string;
  status: BundleStatus;
}

/** A recorded synthesis request plan (contract §13.2, §15). */
export interface PlanReport {
  runId: string;
  plan: TtsRequestPlan;
}

/** A recorded PerformanceScript (contract §14). */
export interface ScriptReport {
  runId: string;
  script: PerformanceScript;
}

/** Result of one synthesis (contract §13.2, §15). */
export interface SynthesisReport {
  runId: string;
  planId: string;
  segmentId: string;
  /** The recorded take, carrying the authorization the charge rests on (§19.3). */
  take: TakeRecord;
  /** Which adapter performed it, for trace (contract §20). */
  adapterId: string;
}

/** Result of attaching a human decision to a take (contract §13.3, §15). */
export interface TakeDecisionReport {
  runId: string;
  take: TakeRecord;
}

/** Takes recorded for a Run, with what they imply (contract §15, §15.1). */
export interface TakeReport {
  runId: string;
  takes: TakeRecord[];
  /** Per-segment lineage: attempts, supersession, and which take was accepted. */
  lineage: SegmentLineage[];
  /**
   * Segments with no accepted take yet (contract §13.3).
   *
   * §13.3 keeps final performance approval human-owned, so these are what still needs an ear.
   */
  awaitingAcceptance: string[];
}

/** Release receipts and what they imply (contract §17). */
export interface ReleaseReport {
  runId: string;
  receipts: ReleaseReceipt[];
  /** Receipts whose status is `pending`, i.e. operations whose outcome is unknown. */
  pending: ReleaseReceipt[];
  /** Receipts whose status is `failed`. */
  failed: ReleaseReceipt[];
}

/**
 * What each declared rework policy would do next (#220 criterion 7).
 *
 * Read-only and derived. Nothing in it is stored, and nothing producing it runs a repair or spends
 * anything — it is the answer to "why is this loop where it is", which is the question an operator
 * had to reconstruct from eight stage executions before rounds were derivable.
 */
export interface ReworkStatusReport {
  runId: string;
  loops: ReworkLoopStatus[];
}

/** One policy's loop, as the record shows it. */
export interface ReworkLoopStatus {
  policyId: string;
  /** The evaluating stage the policy governs. */
  stageId: string;
  /** Completed rounds, derived from the record (ADR-0055). */
  rounds: ReworkRound[];
  /** How much of the bound is spent. Equal to `rounds.length`, named so a reader need not count. */
  spent: number;
  /**
   * What follows, or absent when the evaluating stage has never run.
   *
   * Absent is not "converged". A loop that has not started and a loop that finished clean produce
   * the same empty round list, and reporting a decision for the first would answer a question
   * nobody has asked.
   */
  decision?: ReworkDecision;
}
