/**
 * TypeScript declaration resolution, from a consumer's point of view.
 *
 * Compiled with `tsc --noEmit` inside the clean consumer under `moduleResolution: nodenext`.
 * A package whose `exports` map omits `types`, or whose `.d.ts` files are missing from the
 * tarball, fails here — and would otherwise only fail for the first adopter who tried to use
 * the package from TypeScript.
 *
 * Type-only imports throughout: this file is never executed, and its job is to make the
 * compiler resolve every declaration entry point.
 */

import type {
  ActorRef,
  AldusEvent,
  ArtifactRef,
  CostRecord,
  EpisodeRef,
  GateDecision,
  GateDecisionValue,
  KnowledgePackRef,
  ReleaseReceipt,
  RunManifest,
  StageAttempt,
  StageExecution,
  StructuredError,
} from "@aldus-runtime/core";
import type { FileWorkspace } from "@aldus-runtime/file-store";
import type { GateStatus } from "@aldus-runtime/gate-engine";
import type { StageDefinition } from "@aldus-runtime/stage-runner";
import type { ArtifactArchive } from "@aldus-runtime/artifact-registry";
import type { AldusContextOptions, AldusServices } from "@aldus-runtime/services";
import type { PerformanceSegment } from "@aldus-runtime/tts-ledger";
import type { ReleaseAdapter, ReleaseBundle } from "@aldus-runtime/release";
import type { TestContext } from "@aldus-runtime/testkit";
import type { DefectCase } from "@aldus-runtime/regression";
import type { AldusToolSurfaceOptions } from "@aldus-runtime/mcp";

/**
 * One value of each imported type, so the compiler must resolve every declaration rather than
 * merely parse the import list.
 */
export interface ConsumerSurface {
  actor: ActorRef;
  event: AldusEvent;
  artifact: ArtifactRef;
  cost: CostRecord;
  episode: EpisodeRef;
  decision: GateDecision;
  decisionValue: GateDecisionValue;
  gateStatus: GateStatus;
  pack: KnowledgePackRef;
  receipt: ReleaseReceipt;
  run: RunManifest;
  attempt: StageAttempt;
  execution: StageExecution;
  error: StructuredError;
  workspace: FileWorkspace;
  stage: StageDefinition<unknown, unknown>;
  archive: ArtifactArchive;
  contextOptions: AldusContextOptions;
  services: AldusServices;
  segment: PerformanceSegment;
  releaseAdapter: ReleaseAdapter;
  bundle: ReleaseBundle;
  testContext: TestContext;
  defect: DefectCase;
  toolSurface: AldusToolSurfaceOptions;
}
