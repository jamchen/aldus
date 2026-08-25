import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/index.js";
import { artifactRefSchema, producerProvenanceGap } from "../src/schema/artifact.js";
import type { ArtifactRef } from "../src/schema/artifact.js";

/**
 * Provenance pinned every input and nothing about the producer (#196).
 *
 * The shape is a **list** because an adopter measured that one agent execution reports
 * `modelUsage` as a map keyed by model, and a delegating execution reports more than one. A single
 * producer would have forced a caller to pick, invisibly.
 */

const base = {
  schemaVersion: SCHEMA_VERSION,
  artifactId: "artifact-a",
  kind: "research/thread-proposal",
  uri: "file:///work/threads.md",
  sha256: "a".repeat(64),
  mediaType: "text/markdown",
  producerRunId: "run-a",
  producerStageId: "research.threads",
  inputHashes: [],
  reconstructability: "source",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

const producer = (overrides: Record<string, unknown> = {}) => ({
  id: "provider-a",
  version: "model-a-2026-01",
  versionEvidence: "reported",
  ...overrides,
});

describe("producers", () => {
  it("is optional, so no stored record becomes invalid", () => {
    expect(artifactRefSchema.safeParse(base).success).toBe(true);
  });

  it("carries several producers, because one execution can have several", () => {
    const parsed = artifactRefSchema.parse({
      ...base,
      producers: [producer(), producer({ id: "provider-a", version: "model-b-2026-01" })],
    }) as ArtifactRef;

    expect(parsed.producers).toHaveLength(2);
  });

  it("refuses an empty list, which would assert that nothing produced the bytes", () => {
    expect(artifactRefSchema.safeParse({ ...base, producers: [] }).success).toBe(false);
  });

  it("distinguishes a reported version from a requested one", () => {
    // Measured by an adopter: `--model haiku` in, `claude-haiku-4-5-20251001` out. A field holding
    // the request would record an intention and read as a fact.
    const parsed = artifactRefSchema.parse({
      ...base,
      producers: [producer({ version: "haiku", versionEvidence: "requested" })],
    }) as ArtifactRef;

    expect(parsed.producers?.[0]?.versionEvidence).toBe("requested");
  });

  it("refuses a version whose evidence is unstated", () => {
    const { versionEvidence: _omitted, ...withoutEvidence } = producer();
    expect(artifactRefSchema.safeParse({ ...base, producers: [withoutEvidence] }).success).toBe(
      false,
    );
  });
});

describe("producerProvenanceGap", () => {
  it("reports nothing when a producer is recorded", () => {
    const artifact = artifactRefSchema.parse({ ...base, producers: [producer()] }) as ArtifactRef;
    expect(producerProvenanceGap(artifact)).toBeUndefined();
  });

  it("names the gap on a source artifact as unrecoverable", () => {
    const artifact = artifactRefSchema.parse(base) as ArtifactRef;
    expect(producerProvenanceGap(artifact)).toContain("cannot be regenerated");
  });

  it("names it as recoverable on a reproducible one, without deciding it is acceptable", () => {
    const artifact = artifactRefSchema.parse({
      ...base,
      reconstructability: "reproducible",
    }) as ArtifactRef;

    expect(producerProvenanceGap(artifact)).toContain("can be regenerated");
  });
});
