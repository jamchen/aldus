/**
 * Core schema behaviour (architecture contract §6, §8, §13, §17, §19).
 *
 * Test data uses deliberately fictional placeholders (`example-show`, `provider-a`,
 * `destination-a`). Contract §19.2 forbids Core tests from depending on private Knowledge
 * Packs, and §4.2 keeps adopter identities out of Core entirely.
 */

import { describe, expect, it } from "vitest";

import {
  actorRefSchema,
  artifactRefSchema,
  costRecordSchema,
  episodeRefSchema,
  gateDecisionSchema,
  knowledgePackRefSchema,
  moneySchema,
  releaseReceiptSchema,
  runManifestSchema,
  stageAttemptSchema,
  stageExecutionSchema,
  listSchemaNames,
  coreSchemas,
  VERSIONED_SCHEMA_NAMES,
  isVersionedSchemaName,
} from "../src/schema/index.js";
import { structuredErrorSchema } from "../src/errors.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const AT = "2026-08-18T10:00:00Z";

const actor = { kind: "human", id: "operator-1" } as const;

const episode = {
  schemaVersion: "1.0",
  episodeId: "show:example-show:episode:first-light",
  showId: "example-show",
};

const artifact = {
  schemaVersion: "1.0",
  artifactId: "art_01JXYZ",
  kind: "CanonicalScript",
  uri: "file:///workspace/script.md",
  sha256: HASH_A,
  mediaType: "text/markdown",
  producerRunId: "run_01JXYZ",
  producerStageId: "write-script",
  inputHashes: [HASH_B],
  reconstructability: "reproducible",
  createdAt: AT,
};

const attempt = {
  attemptId: "att_01JXYZ",
  stageId: "write-script",
  attempt: 1,
  status: "succeeded",
  actor,
  inputArtifacts: [],
  outputArtifacts: [artifact],
};

describe("registry", () => {
  it("registers exactly the eleven core domain types", () => {
    expect(listSchemaNames()).toEqual([
      "EpisodeRef",
      "RunManifest",
      "StageExecution",
      "StageAttempt",
      "ArtifactRef",
      "GateDecision",
      "CostRecord",
      "ReleaseReceipt",
      "KnowledgePackRef",
      "ActorRef",
      "StructuredError",
    ]);
    expect(listSchemaNames()).toHaveLength(11);
  });

  it("marks only standalone documents as versioned (ADR-0003)", () => {
    // Embedded value objects inherit their container's version, so a version check on them
    // would have nothing to read.
    expect(isVersionedSchemaName("StageAttempt")).toBe(false);
    expect(isVersionedSchemaName("ActorRef")).toBe(false);
    expect(isVersionedSchemaName("KnowledgePackRef")).toBe(false);
    expect(isVersionedSchemaName("StructuredError")).toBe(false);
    for (const name of VERSIONED_SCHEMA_NAMES) expect(isVersionedSchemaName(name)).toBe(true);
  });

  it("gives every registered schema a metadata id and description", () => {
    for (const [name, schema] of Object.entries(coreSchemas)) {
      const meta = schema.meta();
      expect(meta?.id, `${name} must declare a meta id`).toBeTruthy();
      expect(String(meta?.description ?? ""), `${name} must document itself`).toContain("§");
    }
  });
});

describe("EpisodeRef (§6.1)", () => {
  it("accepts a minimal record", () => {
    expect(episodeRefSchema.safeParse(episode).success).toBe(true);
  });

  it("accepts a maximal record", () => {
    expect(
      episodeRefSchema.safeParse({ ...episode, title: "First Light", legacyRef: "2024/ep-07" })
        .success,
    ).toBe(true);
  });

  it("accepts either canonical identity form the contract documents", () => {
    for (const episodeId of [
      "show:example-show:episode:first-light",
      "series:example-series:edition:2026-08",
    ]) {
      expect(episodeRefSchema.safeParse({ ...episode, episodeId }).success).toBe(true);
    }
  });

  it("rejects a malformed schema version", () => {
    expect(episodeRefSchema.safeParse({ ...episode, schemaVersion: "1" }).success).toBe(false);
    expect(episodeRefSchema.safeParse({ ...episode, schemaVersion: "1.0.0" }).success).toBe(false);
  });

  it("accepts a schema version other than the current one", () => {
    // ADR-0003: pinning to the literal current version would make every forward-compatible read
    // fail, which is the case the version field exists to support.
    expect(episodeRefSchema.safeParse({ ...episode, schemaVersion: "1.7" }).success).toBe(true);
  });
});

describe("ArtifactRef (§8)", () => {
  it("accepts a minimal and a maximal record", () => {
    expect(artifactRefSchema.safeParse(artifact).success).toBe(true);
    expect(artifactRefSchema.safeParse({ ...artifact, sizeBytes: 4096 }).success).toBe(true);
  });

  it("rejects a non-hex or wrong-length digest", () => {
    expect(artifactRefSchema.safeParse({ ...artifact, sha256: "abc" }).success).toBe(false);
    expect(artifactRefSchema.safeParse({ ...artifact, sha256: `z${"a".repeat(63)}` }).success).toBe(
      false,
    );
  });

  it("rejects an uppercase digest", () => {
    // §8.1 makes hashes load-bearing identity; two spellings of one digest must not exist.
    expect(artifactRefSchema.safeParse({ ...artifact, sha256: "A".repeat(64) }).success).toBe(
      false,
    );
  });

  it("rejects a malformed input hash", () => {
    expect(artifactRefSchema.safeParse({ ...artifact, inputHashes: ["nope"] }).success).toBe(false);
  });

  it("rejects a negative or fractional size", () => {
    expect(artifactRefSchema.safeParse({ ...artifact, sizeBytes: -1 }).success).toBe(false);
    expect(artifactRefSchema.safeParse({ ...artifact, sizeBytes: 1.5 }).success).toBe(false);
  });

  it("rejects an unknown reconstructability", () => {
    expect(artifactRefSchema.safeParse({ ...artifact, reconstructability: "maybe" }).success).toBe(
      false,
    );
  });

  it("rejects a timestamp without an offset", () => {
    expect(
      artifactRefSchema.safeParse({ ...artifact, createdAt: "2026-08-18T10:00:00" }).success,
    ).toBe(false);
  });

  it("accepts an arbitrary `kind`", () => {
    // §4.2: Core names no artifact taxonomy. This test exists to stop a future contributor
    // narrowing `kind` to a union of the forms listed in §8.2.
    for (const kind of ["EpisodeBrief", "ReleaseBundle", "adopter.custom/thing", "未命名"]) {
      expect(artifactRefSchema.safeParse({ ...artifact, kind }).success).toBe(true);
    }
  });
});

describe("StageAttempt and StageExecution (§6.3)", () => {
  it("accepts a minimal and a maximal attempt", () => {
    expect(stageAttemptSchema.safeParse(attempt).success).toBe(true);
    expect(
      stageAttemptSchema.safeParse({
        ...attempt,
        status: "failed",
        startedAt: AT,
        finishedAt: AT,
        error: {
          code: "X_FAILED",
          category: "provider",
          message: "upstream refused",
          retryable: true,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects a zero or fractional attempt ordinal", () => {
    expect(stageAttemptSchema.safeParse({ ...attempt, attempt: 0 }).success).toBe(false);
    expect(stageAttemptSchema.safeParse({ ...attempt, attempt: 1.5 }).success).toBe(false);
  });

  it("accepts strictly ascending attempts", () => {
    expect(
      stageExecutionSchema.safeParse({
        schemaVersion: "1.0",
        runId: "run_01JXYZ",
        stageId: "write-script",
        status: "succeeded",
        attempts: [attempt, { ...attempt, attemptId: "att_2", attempt: 2 }],
      }).success,
    ).toBe(true);
  });

  it("rejects out-of-order or duplicated attempt ordinals", () => {
    // §6.3: attempts are append-only audit records. A repeated ordinal means a writer
    // overwrote history rather than appending to it.
    const base = {
      schemaVersion: "1.0",
      runId: "run_01JXYZ",
      stageId: "write-script",
      status: "succeeded",
    };
    const descending = stageExecutionSchema.safeParse({
      ...base,
      attempts: [
        { ...attempt, attempt: 2 },
        { ...attempt, attemptId: "att_2", attempt: 1 },
      ],
    });
    const duplicated = stageExecutionSchema.safeParse({
      ...base,
      attempts: [attempt, { ...attempt, attemptId: "att_2", attempt: 1 }],
    });
    expect(descending.success).toBe(false);
    expect(duplicated.success).toBe(false);
    expect(descending.error?.issues[0]?.path).toEqual(["attempts"]);
  });

  it("accepts an empty attempt list", () => {
    expect(
      stageExecutionSchema.safeParse({
        schemaVersion: "1.0",
        runId: "run_01JXYZ",
        stageId: "write-script",
        status: "queued",
        attempts: [],
      }).success,
    ).toBe(true);
  });
});

describe("RunManifest (§6.2)", () => {
  const run = {
    schemaVersion: "1.0",
    runId: "run_01JXYZ",
    episode,
    workflowId: "default-production",
    workflowVersion: "3",
    status: "running",
    knowledgePacks: [],
    createdAt: AT,
    updatedAt: AT,
  };

  it("accepts a minimal and a maximal record", () => {
    expect(runManifestSchema.safeParse(run).success).toBe(true);
    expect(
      runManifestSchema.safeParse({
        ...run,
        currentStage: "write-script",
        codeRevision: "0f1e2d3",
        knowledgePacks: [
          { packId: "example-show-editorial", version: "1", authority: "normative" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(runManifestSchema.safeParse({ ...run, status: "paused" }).success).toBe(false);
  });

  it("rejects an invalid embedded episode", () => {
    expect(
      runManifestSchema.safeParse({ ...run, episode: { ...episode, showId: "" } }).success,
    ).toBe(false);
  });

  it("accepts an arbitrary `workflowId`", () => {
    // §4.2: workflows belong to adopters, not to Core.
    expect(runManifestSchema.safeParse({ ...run, workflowId: "anything/at.all-1" }).success).toBe(
      true,
    );
  });
});

describe("GateDecision (§13)", () => {
  const decision = {
    schemaVersion: "1.0",
    decisionId: "dec_01JXYZ",
    gateId: "content-freeze",
    runId: "run_01JXYZ",
    decision: "approved",
    subjectHashes: [HASH_A],
    decidedBy: actor,
    decidedAt: AT,
    expiresOnChange: true,
  };

  it("accepts a minimal and a maximal record", () => {
    expect(gateDecisionSchema.safeParse(decision).success).toBe(true);
    expect(
      gateDecisionSchema.safeParse({ ...decision, comment: "Claims verified against sources." })
        .success,
    ).toBe(true);
  });

  it("accepts every documented outcome, including `waived`", () => {
    for (const value of ["approved", "rejected", "changes_requested", "waived"]) {
      expect(gateDecisionSchema.safeParse({ ...decision, decision: value }).success).toBe(true);
    }
  });

  it("requires expiresOnChange to be stated explicitly", () => {
    const { expiresOnChange: _omitted, ...withoutPolicy } = decision;
    expect(gateDecisionSchema.safeParse(withoutPolicy).success).toBe(false);
  });

  it("rejects a malformed subject hash", () => {
    // §13.2 forbids paid synthesis without a valid hash-bound authorization.
    expect(gateDecisionSchema.safeParse({ ...decision, subjectHashes: ["x"] }).success).toBe(false);
  });
});

describe("CostRecord (§19.3)", () => {
  const cost = {
    schemaVersion: "1.0",
    costId: "cost_01JXYZ",
    runId: "run_01JXYZ",
    provider: "provider-a",
    operation: "synthesize",
    billingStatus: "charged",
    actual: { amount: "0.0142", currency: "USD" },
    recordedAt: AT,
  };

  it("accepts a minimal and a maximal record", () => {
    expect(costRecordSchema.safeParse(cost).success).toBe(true);
    expect(
      costRecordSchema.safeParse({
        ...cost,
        stageId: "synthesize",
        attemptId: "att_01JXYZ",
        quantity: { unit: "characters", amount: 1820 },
        estimated: { amount: "0.0150", currency: "USD" },
        authorizationId: "dec_01JXYZ",
        providerRequestId: "req-abc",
      }).success,
    ).toBe(true);
  });

  it("accepts a preview-only record", () => {
    const { actual: _dropped, ...preview } = cost;
    expect(
      costRecordSchema.safeParse({
        ...preview,
        billingStatus: "estimated",
        estimated: { amount: "0.02", currency: "USD" },
      }).success,
    ).toBe(true);
  });

  it("rejects a record stating neither an estimate nor an actual", () => {
    // §19.3: such a record would silently under-report spend against a budget.
    const { actual: _dropped, ...neither } = cost;
    const result = costRecordSchema.safeParse(neither);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["actual"]);
  });

  it("rejects a numeric amount", () => {
    // Money is a decimal string; IEEE-754 accumulation corrupts fractional-cent totals.
    expect(
      costRecordSchema.safeParse({ ...cost, actual: { amount: 0.0142, currency: "USD" } }).success,
    ).toBe(false);
  });

  it("rejects a malformed decimal amount", () => {
    for (const amount of ["1.2.3", "", "1,5", "0x10", " 1.0"]) {
      expect(moneySchema.safeParse({ amount, currency: "USD" }).success, amount).toBe(false);
    }
  });

  it("rejects a non-ISO-4217 currency", () => {
    for (const currency of ["usd", "US", "USDT"]) {
      expect(moneySchema.safeParse({ amount: "1.00", currency }).success, currency).toBe(false);
    }
  });

  it("accepts `unknown` billing status", () => {
    // §19.3 "safe handling of unknown provider billing status".
    expect(costRecordSchema.safeParse({ ...cost, billingStatus: "unknown" }).success).toBe(true);
  });

  it("accepts arbitrary `provider` and `operation` values", () => {
    // §4.2: Core names no provider. This test exists to stop them being narrowed to a union.
    expect(
      costRecordSchema.safeParse({ ...cost, provider: "provider-b", operation: "render.v2" })
        .success,
    ).toBe(true);
  });
});

describe("ReleaseReceipt (§17)", () => {
  const receipt = {
    schemaVersion: "1.0",
    releaseId: "rel_01JXYZ",
    runId: "run_01JXYZ",
    destination: "destination-a",
    operation: "upload-media",
    idempotencyKey: "run_01JXYZ:upload-media:1",
    status: "succeeded",
    inputHashes: [HASH_A],
  };

  it("accepts a minimal and a maximal record", () => {
    expect(releaseReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      releaseReceiptSchema.safeParse({
        ...receipt,
        remoteId: "remote-1",
        remoteUrl: "https://example.invalid/item/1",
        completedAt: AT,
      }).success,
    ).toBe(true);
  });

  it("requires an idempotency key", () => {
    // §17: each operation MUST be independently idempotent and resumable.
    const { idempotencyKey: _omitted, ...withoutKey } = receipt;
    expect(releaseReceiptSchema.safeParse(withoutKey).success).toBe(false);
  });

  it("accepts a pending receipt with no completion time", () => {
    expect(releaseReceiptSchema.safeParse({ ...receipt, status: "pending" }).success).toBe(true);
  });

  it("accepts arbitrary `destination` and `operation` values", () => {
    // §1.2 rules out prescribing release targets.
    expect(
      releaseReceiptSchema.safeParse({
        ...receipt,
        destination: "destination-b",
        operation: "set-visibility",
      }).success,
    ).toBe(true);
  });

  it("carries a structured error on failure", () => {
    const result = releaseReceiptSchema.safeParse({
      ...receipt,
      status: "failed",
      error: {
        code: "REMOTE_REJECTED",
        category: "provider",
        message: "rejected",
        retryable: true,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("embedded value objects", () => {
  it("accepts every actor kind", () => {
    for (const kind of ["human", "agent", "worker", "system"]) {
      expect(actorRefSchema.safeParse({ kind, id: "x" }).success).toBe(true);
    }
    expect(actorRefSchema.safeParse({ kind: "robot", id: "x" }).success).toBe(false);
  });

  it("accepts a maximal actor", () => {
    expect(
      actorRefSchema.safeParse({
        kind: "agent",
        id: "agent-1",
        displayName: "Session agent",
        backendId: "backend-a",
        sessionRef: "session-1",
      }).success,
    ).toBe(true);
  });

  it("accepts every pack authority and an open scope map", () => {
    for (const authority of ["normative", "advisory", "example", "deprecated"]) {
      expect(
        knowledgePackRefSchema.safeParse({ packId: "p", version: "1", authority }).success,
      ).toBe(true);
    }
    expect(
      knowledgePackRefSchema.safeParse({
        packId: "p",
        version: "1",
        authority: "normative",
        scope: { show: "example-show", host: "example-host", anythingElse: "value" },
        precedence: 10,
        sourceRevision: "0f1e2d3",
        contentHash: HASH_A,
      }).success,
    ).toBe(true);
  });

  it("validates a bounded structured error cause chain", () => {
    expect(
      structuredErrorSchema.safeParse({
        code: "A",
        category: "io",
        message: "outer",
        retryable: true,
        causes: [{ code: "B", category: "io", message: "inner", retryable: false }],
      }).success,
    ).toBe(true);
    expect(
      structuredErrorSchema.safeParse({
        code: "A",
        category: "nope",
        message: "m",
        retryable: true,
      }).success,
    ).toBe(false);
  });
});
