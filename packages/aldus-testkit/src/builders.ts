/**
 * Test data builders for the Aldus Core domain types.
 *
 * One builder per registered core schema (architecture contract §6, §8, §9.1, §13, §17, §19).
 * Every builder returns a record that passes `validate()` unmodified, so a test that needs "a
 * valid Run" writes one call instead of thirty lines of literal, and a test that needs an
 * *invalid* one states the single defect it cares about.
 *
 * ## Override semantics
 *
 * Overrides are applied **shallowly**, at the top level only, and the type is `Partial<T>`
 * rather than a recursive partial. That is deliberate: a recursive partial would let a caller
 * write `{ episode: { title: "x" } }` and silently receive an `EpisodeRef` missing its required
 * fields. With `Partial<T>`, the type system requires a nested record to be supplied whole —
 * build it with its own builder and pass the result.
 *
 * An override whose value is `undefined` is ignored rather than deleting the default. Deleting
 * a field is expressed by building the record and using `omit()`, so that "leave it alone" and
 * "remove it" cannot be confused at a call site.
 *
 * ## Boundary
 *
 * Contract §4.2 keeps show, host, provider, and platform identities out of Core, and §19.2
 * forbids Core tests from depending on private Knowledge Packs. Every default here is
 * transparently fictional — `example-show`, `provider-a`, `destination-a` — and must stay that
 * way.
 */

import {
  type ActorRef,
  type ArtifactRef,
  type CostRecord,
  type EpisodeRef,
  type GateDecision,
  type KnowledgePackRef,
  type Money,
  type ReleaseReceipt,
  type RunManifest,
  type SchemaName,
  type SchemaTypeFor,
  type StageAttempt,
  type StageExecution,
  type StructuredError,
  SCHEMA_VERSION,
  formatEpisodeId,
  validate,
} from "@aldus/core";

import { createTestContext, testDigest, type TestContext } from "./clock.js";

/* -------------------------------------------------------------------------------------------
 * Override machinery
 * ---------------------------------------------------------------------------------------- */

/**
 * Apply a shallow override, ignoring keys whose value is `undefined`.
 *
 * The `undefined` skip matters under `exactOptionalPropertyTypes`: a plain spread would set the
 * property to an explicit `undefined`, which is a different shape from an absent property and
 * survives into `JSON.stringify` output as a missing key but into `Object.keys` as a present
 * one. Skipping keeps "not overridden" and "absent" identical.
 */
function applyOverrides<T extends object>(base: T, overrides: Partial<T> | undefined): T {
  if (overrides === undefined) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * Remove keys from a record, returning a value the type system still treats as `T`.
 *
 * For negative tests only: the point is to produce a record missing a required field, which is
 * by definition not a valid `T`. The cast is contained here rather than at every call site.
 */
export function omit<T extends object>(record: T, ...keys: string[]): T {
  const result = { ...record } as Record<string, unknown>;
  for (const key of keys) delete result[key];
  return result as T;
}

/**
 * Produce a record that is valid except for one deliberate defect.
 *
 * Negative tests read better when the defect is the only thing visible at the call site:
 *
 * ```ts
 * const record = buildInvalid(buildArtifactRef, (artifact) => ({ ...artifact, sha256: "nope" }));
 * ```
 *
 * `mutate` receives the valid record and returns the damaged one. The return type stays `T` so
 * the value can be handed to a validator that expects `unknown`.
 */
export function buildInvalid<T extends object>(
  builder: (overrides?: Partial<T>, context?: TestContext) => T,
  mutate: (valid: T) => T,
  context?: TestContext,
): T {
  return mutate(builder(undefined, context));
}

/** Fall back to a fresh deterministic context when a call site does not supply one. */
function resolveContext(context: TestContext | undefined): TestContext {
  return context ?? createTestContext();
}

/* -------------------------------------------------------------------------------------------
 * Embedded value objects
 * ---------------------------------------------------------------------------------------- */

/** Build an {@link ActorRef} (contract §6.4, §19.2). */
export function buildActorRef(overrides?: Partial<ActorRef>, context?: TestContext): ActorRef {
  void resolveContext(context);
  return applyOverrides<ActorRef>(
    {
      kind: "human",
      id: "operator-a",
      displayName: "Operator A",
      backendId: "backend-a",
      sessionRef: "session-a",
    },
    overrides,
  );
}

/** Build a {@link StructuredError} (contract §19.1). */
export function buildStructuredError(
  overrides?: Partial<StructuredError>,
  context?: TestContext,
): StructuredError {
  const { clock } = resolveContext(context);
  return applyOverrides<StructuredError>(
    {
      code: "ALDUS_EXAMPLE_FAILURE",
      category: "io",
      message: "The stage could not read its declared input.",
      retryable: true,
      details: { stageId: "stage-a" },
      causes: [
        {
          code: "ALDUS_EXAMPLE_ROOT_CAUSE",
          category: "io",
          message: "The underlying read returned no bytes.",
          retryable: true,
        },
      ],
      occurredAt: clock.nowIso(),
    },
    overrides,
  );
}

/** Build a {@link KnowledgePackRef} (contract §9.1, §6.2). */
export function buildKnowledgePackRef(
  overrides?: Partial<KnowledgePackRef>,
  context?: TestContext,
): KnowledgePackRef {
  void resolveContext(context);
  return applyOverrides<KnowledgePackRef>(
    {
      packId: "example-show-editorial",
      version: "1",
      authority: "normative",
      scope: { show: "example-show", host: "example-host" },
      precedence: 20,
      sourceRevision: "revision-a",
      contentHash: testDigest("pack:example-show-editorial"),
    },
    overrides,
  );
}

/** Build a {@link Money} value (contract §19.3). */
export function buildMoney(overrides?: Partial<Money>): Money {
  return applyOverrides<Money>({ amount: "0.0142", currency: "USD" }, overrides);
}

/* -------------------------------------------------------------------------------------------
 * Standalone documents
 * ---------------------------------------------------------------------------------------- */

/** Build an {@link EpisodeRef} (contract §6.1). */
export function buildEpisodeRef(
  overrides?: Partial<EpisodeRef>,
  context?: TestContext,
): EpisodeRef {
  void resolveContext(context);
  return applyOverrides<EpisodeRef>(
    {
      schemaVersion: SCHEMA_VERSION,
      episodeId: formatEpisodeId("example-show", "episode-a"),
      showId: "example-show",
      title: "Example Episode A",
      legacyRef: "legacy/example-show/episode-a",
    },
    overrides,
  );
}

/** Build an {@link ArtifactRef} (contract §8). */
export function buildArtifactRef(
  overrides?: Partial<ArtifactRef>,
  context?: TestContext,
): ArtifactRef {
  const ctx = resolveContext(context);
  return applyOverrides<ArtifactRef>(
    {
      schemaVersion: SCHEMA_VERSION,
      artifactId: ctx.ids.newArtifactId(),
      kind: "CanonicalScript",
      uri: "file:///workspace/artifacts/canonical-script.json",
      sha256: testDigest("artifact:canonical-script"),
      mediaType: "application/json",
      sizeBytes: 4096,
      producerRunId: "run-a",
      producerStageId: "stage-a",
      inputHashes: [testDigest("input:episode-brief")],
      reconstructability: "reproducible",
      createdAt: ctx.clock.nowIso(),
    },
    overrides,
  );
}

/** Build a {@link RunManifest} (contract §6.2). */
export function buildRunManifest(
  overrides?: Partial<RunManifest>,
  context?: TestContext,
): RunManifest {
  const ctx = resolveContext(context);
  return applyOverrides<RunManifest>(
    {
      schemaVersion: SCHEMA_VERSION,
      runId: ctx.ids.newRunId(),
      episode: buildEpisodeRef(undefined, ctx),
      workflowId: "workflow-a",
      workflowVersion: "1.0.0",
      status: "running",
      currentStage: "stage-a",
      codeRevision: "revision-a",
      knowledgePacks: [buildKnowledgePackRef(undefined, ctx)],
      createdAt: ctx.clock.nowIso(),
      updatedAt: ctx.clock.nowIso(),
    },
    overrides,
  );
}

/** Build a {@link StageAttempt} (contract §6.3). */
export function buildStageAttempt(
  overrides?: Partial<StageAttempt>,
  context?: TestContext,
): StageAttempt {
  const ctx = resolveContext(context);
  return applyOverrides<StageAttempt>(
    {
      attemptId: ctx.ids.newStageAttemptId(),
      stageId: "stage-a",
      attempt: 1,
      status: "succeeded",
      actor: buildActorRef(undefined, ctx),
      inputArtifacts: [buildArtifactRef({ kind: "EpisodeBrief" }, ctx)],
      outputArtifacts: [buildArtifactRef({ kind: "CanonicalScript" }, ctx)],
      startedAt: ctx.clock.nowIso(),
      finishedAt: ctx.clock.nowIso(),
      error: buildStructuredError(undefined, ctx),
    },
    overrides,
  );
}

/**
 * Build a {@link StageExecution} (contract §6.3).
 *
 * Defaults to two attempts with ascending ordinals, because Core enforces strictly ascending
 * `attempt` values and a single-attempt default would never exercise that rule.
 */
export function buildStageExecution(
  overrides?: Partial<StageExecution>,
  context?: TestContext,
): StageExecution {
  const ctx = resolveContext(context);
  return applyOverrides<StageExecution>(
    {
      schemaVersion: SCHEMA_VERSION,
      runId: "run-a",
      stageId: "stage-a",
      stageVersion: "1.0.0",
      status: "succeeded",
      attempts: [
        buildStageAttempt({ attempt: 1, status: "failed" }, ctx),
        buildStageAttempt({ attempt: 2, status: "succeeded" }, ctx),
      ],
      startedAt: ctx.clock.nowIso(),
      finishedAt: ctx.clock.nowIso(),
    },
    overrides,
  );
}

/** Build a {@link GateDecision} (contract §13). */
export function buildGateDecision(
  overrides?: Partial<GateDecision>,
  context?: TestContext,
): GateDecision {
  const ctx = resolveContext(context);
  return applyOverrides<GateDecision>(
    {
      schemaVersion: SCHEMA_VERSION,
      decisionId: ctx.ids.newGateDecisionId(),
      gateId: "content-freeze",
      runId: "run-a",
      decision: "approved",
      subjectHashes: [testDigest("subject:approved-narration")],
      decidedBy: buildActorRef(undefined, ctx),
      decidedAt: ctx.clock.nowIso(),
      comment: "Reviewed against the approved narration.",
      expiresOnChange: true,
    },
    overrides,
  );
}

/** Build a {@link CostRecord} (contract §19.3, §15). */
export function buildCostRecord(
  overrides?: Partial<CostRecord>,
  context?: TestContext,
): CostRecord {
  const ctx = resolveContext(context);
  return applyOverrides<CostRecord>(
    {
      schemaVersion: SCHEMA_VERSION,
      costId: ctx.ids.newCostId(),
      runId: "run-a",
      stageId: "stage-a",
      attemptId: "attempt-a",
      provider: "provider-a",
      operation: "synthesis",
      quantity: { unit: "characters", amount: 1420 },
      estimated: buildMoney(),
      actual: buildMoney({ amount: "0.0138" }),
      billingStatus: "charged",
      authorizationId: "decision-a",
      providerRequestId: "provider-request-a",
      recordedAt: ctx.clock.nowIso(),
    },
    overrides,
  );
}

/** Build a {@link ReleaseReceipt} (contract §17). */
export function buildReleaseReceipt(
  overrides?: Partial<ReleaseReceipt>,
  context?: TestContext,
): ReleaseReceipt {
  const ctx = resolveContext(context);
  return applyOverrides<ReleaseReceipt>(
    {
      schemaVersion: SCHEMA_VERSION,
      releaseId: ctx.ids.newReleaseId(),
      runId: "run-a",
      destination: "destination-a",
      operation: "media-upload",
      idempotencyKey: "run-a:destination-a:media-upload",
      status: "succeeded",
      remoteId: "remote-a",
      remoteUrl: "https://destination-a.example/items/remote-a",
      inputHashes: [testDigest("release:final-render")],
      completedAt: ctx.clock.nowIso(),
      error: buildStructuredError(undefined, ctx),
    },
    overrides,
  );
}

/* -------------------------------------------------------------------------------------------
 * Registry
 * ---------------------------------------------------------------------------------------- */

/**
 * Every builder, keyed by the schema name it produces.
 *
 * Exposed so a test can assert a property across all eleven types in a loop rather than eleven
 * near-identical assertions — the form that actually fails when a twelfth type is added and
 * forgotten.
 */
export const builders = {
  EpisodeRef: buildEpisodeRef,
  RunManifest: buildRunManifest,
  StageExecution: buildStageExecution,
  StageAttempt: buildStageAttempt,
  ArtifactRef: buildArtifactRef,
  GateDecision: buildGateDecision,
  CostRecord: buildCostRecord,
  ReleaseReceipt: buildReleaseReceipt,
  KnowledgePackRef: buildKnowledgePackRef,
  ActorRef: buildActorRef,
  StructuredError: buildStructuredError,
} as const satisfies {
  [N in SchemaName]: (overrides?: never, context?: TestContext) => SchemaTypeFor<N>;
};

/**
 * Build the default record for a schema by name.
 *
 * @throws {Error} if the built record does not validate — a builder that drifts out of sync
 * with its schema should fail loudly at the point of use, not silently supply bad test data.
 */
export function buildFor<N extends SchemaName>(name: N, context?: TestContext): SchemaTypeFor<N> {
  const builder = builders[name] as (
    overrides?: undefined,
    context?: TestContext,
  ) => SchemaTypeFor<N>;
  const record = builder(undefined, context);
  const result = validate(name, record);
  if (!result.ok) {
    throw new Error(
      `Builder for ${name} produced an invalid record: ${JSON.stringify(result.error.details)}`,
    );
  }
  return record;
}
