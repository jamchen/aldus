/**
 * The structured shapes services return.
 *
 * Kept in one module because these are the package's public contract with its adapters: the CLI
 * renders them, the Production MCP (WP-11) serialises them, and neither may add a field the
 * other cannot see. Contract §18 makes both adapters over the same services, and a shape defined
 * inside one service's file drifts into being that service's private business.
 */

import type {
  ArtifactRef,
  CostRecord,
  EpisodeRef,
  ReleaseReceipt,
  RunManifest,
  StructuredError,
} from "@aldus-runtime/core";
import type { GateStatus } from "@aldus-runtime/gate-engine";

import type { ActionPlan, StageSnapshot } from "./nextaction.js";

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
}

/** A Run's full situation (contract §24). */
export interface RunReport {
  run: RunManifest;
  stages: StageReport[];
  gates: GateStatus[];
  costs: CostSummary;
  /** What is safe to do now, and why everything else is not. */
  plan: ActionPlan;
}

/** A Run reduced to what a list needs. */
export interface RunSummary {
  runId: string;
  status: RunManifest["status"];
  workflowId: string;
  workflowVersion: string;
  currentStage?: string;
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
}

/** Artifacts recorded against a Run (contract §8). */
export interface ArtifactReport {
  runId: string;
  artifacts: ArtifactRef[];
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
