/**
 * Fixtures for the composed-stack scenarios.
 *
 * Every identifier is fictional. Architecture contract §4.2 keeps provider, platform, and adopter
 * identities out of the runtime including its test data, and §19.2 requires that no private
 * Knowledge Pack be needed to run these tests. `example-show`, `provider-a`, `voice-a`, and
 * `destination-a` are the whole vocabulary.
 */

import type { Money } from "@aldus-runtime/core";
import { SCHEMA_VERSION, formatEpisodeId } from "@aldus-runtime/core";
import {
  digestSubjectValue,
  grantTermsDigest,
  type GateDefinition,
  type SpendGrant,
  type SubjectsByGate,
} from "@aldus-runtime/gate-engine";
import { bestEffortOperation, requiredOperation, type ReleaseBundle } from "@aldus-runtime/release";
import type { WorkflowGraph } from "@aldus-runtime/services";
import {
  planSubjectDigests,
  type PerformanceScript,
  type TtsRequestPlan,
} from "@aldus-runtime/tts-ledger";

/** The show every scenario uses. */
export const SHOW_ID = "example-show";
/** The episode slug the primary journey uses. */
export const EPISODE_SLUG = "episode-a";
/** Canonical Episode identity for the primary journey (contract §6.1). */
export const EPISODE_ID = formatEpisodeId(SHOW_ID, EPISODE_SLUG);
/** The Run the primary journey drives. */
export const RUN_ID = "run-a";
/** The one release destination. Opaque to Aldus (§4.2). */
export const DESTINATION_A = "destination-a";

/** Stage that produces the narration artifact. */
export const NARRATION_STAGE = "stage-narration";
/** Stage that halts at the content freeze. */
export const REVIEW_STAGE = "stage-review";
/** Stage that produces the render, after the freeze is decided. */
export const RENDER_STAGE = "stage-render";

/** Gate approving the exact spoken content (contract §13.1). */
export const CONTENT_FREEZE_GATE = "content-freeze";
/** Gate authorizing paid synthesis (contract §13.2). */
export const PERFORMANCE_FREEZE_GATE = "performance-freeze";
/** Gate authorizing upload (contract §13.4). */
export const UPLOAD_GATE = "release-upload";
/** Gate authorizing public release, separately (contract §13.4). */
export const PUBLISH_GATE = "release-publish";

/** Authority an approved upload gate grants. */
export const UPLOAD_AUTHORITY = "release.upload";
/** Authority an approved publish gate grants. */
export const PUBLISH_AUTHORITY = "release.publish";

/** Subject key carrying the approved spend ceiling (ADR-0009). */
export const SPEND_LIMITS_KEY = "spend-limits";
/** Subject key carrying the frozen content digest. */
export const CONTENT_KEY = "spoken-text";
/** Subject key carrying the final render digest. */
export const RENDER_KEY = "render";

/** A PerformanceScript with two segments (contract §14.1). */
export function aScript(overrides: Partial<PerformanceScript> = {}): PerformanceScript {
  return {
    schemaVersion: SCHEMA_VERSION,
    scriptId: "script-a",
    runId: RUN_ID,
    origin: "authored",
    segments: [
      { segmentId: "seg-1", spokenText: "The first line." },
      { segmentId: "seg-2", spokenText: "The second line." },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as PerformanceScript;
}

/** A request plan covering both segments (contract §15, §13.2). */
export function aPlan(overrides: Partial<TtsRequestPlan> = {}): TtsRequestPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    planId: "plan-a",
    runId: RUN_ID,
    scriptId: "script-a",
    scriptSha256: "b".repeat(64),
    parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
    segments: [
      { segmentId: "seg-1", text: { raw: "The first line." } },
      { segmentId: "seg-2", text: { raw: "The second line." } },
    ],
    estimatedTotal: { amount: "0.0200", currency: "USD" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as TtsRequestPlan;
}

/** A spend grant over the performance freeze (contract §13.2, §19.3). */
export function aGrant(overrides: Partial<SpendGrant> = {}): SpendGrant {
  return {
    grantId: "grant-a",
    runId: RUN_ID,
    gateId: PERFORMANCE_FREEZE_GATE,
    decisionId: "decision-a",
    scope: { operations: ["tts.synthesize"] },
    maxTotal: { amount: "10.00", currency: "USD" } satisfies Money,
    ...overrides,
  };
}

/**
 * The journey's stage↔gate graph (contract §11, ADR-0021).
 *
 * This is what §11 means by "a versioned graph of stages and gates", and declaring it is what
 * stops an unrelated release gate from suppressing narration work. Narration requires nothing —
 * it produces the content the content freeze later approves, so gating it on that freeze would be
 * circular.
 */
export function journeyWorkflow(): WorkflowGraph {
  return {
    workflowId: "workflow-a",
    workflowVersion: "1",
    stages: [
      { stageId: NARRATION_STAGE, requiredGates: [] },
      { stageId: REVIEW_STAGE, requiredGates: [] },
      { stageId: RENDER_STAGE, requiredGates: [CONTENT_FREEZE_GATE] },
    ],
  };
}

/**
 * Every gate the journey passes through.
 *
 * `binds` is never empty: the engine refuses a gate binding nothing, because an approval no change
 * could invalidate would outlive the content it approved (§13.1, §13.2).
 */
export function journeyGates(plan: TtsRequestPlan): GateDefinition[] {
  return [
    {
      gateId: CONTENT_FREEZE_GATE,
      level: "human_oracle",
      enforcement: "blocking",
      binds: [CONTENT_KEY],
    },
    {
      gateId: PERFORMANCE_FREEZE_GATE,
      level: "human_oracle",
      enforcement: "blocking",
      binds: [...Object.keys(planSubjectDigests(plan)), SPEND_LIMITS_KEY],
    },
    {
      gateId: UPLOAD_GATE,
      level: "human_oracle",
      enforcement: "blocking",
      binds: [RENDER_KEY],
      grants: [UPLOAD_AUTHORITY],
    },
    {
      gateId: PUBLISH_GATE,
      level: "human_oracle",
      enforcement: "blocking",
      binds: [RENDER_KEY],
      // Publication depends on upload: §13.4 keeps them separate, and approving publication for
      // something never uploaded is not a state an operator should be able to reach.
      dependsOn: [UPLOAD_GATE],
      grants: [PUBLISH_AUTHORITY],
    },
  ];
}

/** What each gate currently binds. Mutable per scenario so a subject can be made to drift. */
export interface JourneySubjects {
  content: string;
  render: string;
  plan: TtsRequestPlan;
  grant: SpendGrant;
}

/**
 * Digests of what every gate binds, as the services' `SubjectsProvider` supplies them.
 *
 * The plan digests come from `planSubjectDigests`, so an approval over them genuinely binds the
 * plan — which `gateEngineSpendAuthorizer` independently verifies rather than trusting.
 */
export function journeySubjects(state: JourneySubjects): SubjectsByGate {
  const render = [{ key: RENDER_KEY, sha256: digestSubjectValue(state.render) }];
  return {
    [CONTENT_FREEZE_GATE]: [{ key: CONTENT_KEY, sha256: digestSubjectValue(state.content) }],
    [PERFORMANCE_FREEZE_GATE]: [
      ...Object.entries(planSubjectDigests(state.plan)).map(([key, sha256]) => ({ key, sha256 })),
      { key: SPEND_LIMITS_KEY, sha256: grantTermsDigest(state.grant) },
    ],
    [UPLOAD_GATE]: render,
    [PUBLISH_GATE]: render,
  };
}

/** A bundle with a required upload, a required publish, and a best-effort notification (§17). */
export function aBundle(overrides: Partial<ReleaseBundle> = {}): ReleaseBundle {
  return {
    bundleId: "bundle-a",
    runId: RUN_ID,
    episodeId: EPISODE_ID,
    required: [
      requiredOperation({
        operationId: "upload",
        kind: "media-upload",
        destination: DESTINATION_A,
        inputHashes: ["c".repeat(64)],
        requiresAuthority: UPLOAD_AUTHORITY,
      }),
      requiredOperation({
        operationId: "publish",
        kind: "visibility-transition",
        destination: DESTINATION_A,
        inputHashes: ["c".repeat(64)],
        requiresAuthority: PUBLISH_AUTHORITY,
      }),
    ],
    bestEffort: [
      bestEffortOperation({
        operationId: "notify",
        kind: "notification",
        destination: DESTINATION_A,
        inputHashes: ["c".repeat(64)],
      }),
    ],
    ...overrides,
  };
}
