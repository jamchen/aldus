/**
 * `@aldus/testkit` — deterministic builders, fixtures, and test doubles for `@aldus/core`.
 *
 * This is the testkit half of architecture contract §22 **WP-01 Core schema and testkit**. It
 * exists so that tests — in Core, and later in the file store, artifact registry, and adopter
 * integrations — can state what they mean instead of assembling thirty lines of literal record.
 *
 * Three things live here:
 *
 * - **Determinism** ({@link createTestContext}) — a frozen clock and a seeded ID source, so an
 *   assertion can name an exact `runId` and timestamp. Contract §3.4 makes durable state
 *   authoritative; a test that can only match state with wildcards is not really checking it.
 * - **Builders** ({@link builders}) — one per registered core schema, each returning a record
 *   that validates unmodified, plus {@link buildInvalid} for stating a single deliberate defect.
 * - **Fixtures** ({@link loadValidFixtures}) — the durable JSON corpus that a non-TypeScript
 *   validator and a future schema migration are checked against.
 *
 * Contract §19.2 forbids Core tests and distributions from requiring private Knowledge Packs.
 * Everything here is transparently fictional — `example-show`, `provider-a`, `destination-a` —
 * and must stay that way (§4.2).
 *
 * @packageDocumentation
 */

export {
  DEFAULT_TEST_SEED,
  TEST_EPOCH_ISO,
  TEST_EPOCH_MS,
  createSeededBytes,
  createTestClock,
  createTestContext,
  createTestIdFactory,
  testDigest,
  type TestClock,
  type TestContext,
  type TestContextOptions,
  type TestIdFactoryOptions,
} from "./clock.js";

export {
  buildActorRef,
  buildArtifactRef,
  buildCostRecord,
  buildEpisodeRef,
  buildFor,
  buildGateDecision,
  buildInvalid,
  buildKnowledgePackRef,
  buildMoney,
  buildReleaseReceipt,
  buildRunManifest,
  buildStageAttempt,
  buildStageExecution,
  buildStructuredError,
  builders,
  omit,
} from "./builders.js";

export {
  FIXTURE_DIR,
  fixtureId,
  loadFixture,
  loadFixtureFile,
  loadInvalidFixtures,
  loadManifest,
  loadValidFixtures,
  type FixtureManifest,
  type InvalidFixtureEntry,
  type LoadedFixture,
  type ValidFixtureEntry,
} from "./fixtures.js";
