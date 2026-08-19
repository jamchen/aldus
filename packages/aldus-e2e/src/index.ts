/**
 * `@aldus-runtime/e2e` — the composed-stack test harness.
 *
 * **Private, and permanently so.** This is not a product: it exists to prove that the packages
 * compose, which is the one thing no per-package test suite can establish. See `README.md`.
 *
 * @packageDocumentation
 */

export { FakeSynthesisAdapter, type RecordedSynthesis } from "./adapters.js";

export {
  AGENT,
  OPERATOR,
  fixedClock,
  makeStack,
  type Stack,
  type StackOptions,
  type StackState,
  type StageFactory,
} from "./harness.js";

export {
  gatedStage,
  producingStage,
  selfRegisteringStage,
  type ProducingStageOptions,
  type SelfRegisteringStageOptions,
} from "./stages.js";

export {
  CONTENT_FREEZE_GATE,
  CONTENT_KEY,
  DESTINATION_A,
  EPISODE_ID,
  EPISODE_SLUG,
  NARRATION_STAGE,
  PERFORMANCE_FREEZE_GATE,
  PUBLISH_AUTHORITY,
  PUBLISH_GATE,
  RENDER_KEY,
  RENDER_STAGE,
  REVIEW_STAGE,
  RUN_ID,
  SHOW_ID,
  SPEND_LIMITS_KEY,
  UPLOAD_AUTHORITY,
  UPLOAD_GATE,
  aBundle,
  aGrant,
  aPlan,
  aScript,
  journeyGates,
  journeyWorkflow,
  journeySubjects,
  type JourneySubjects,
} from "./fixtures.js";
