/**
 * Builders and the determinism they rest on.
 *
 * The builders' contract is narrow but load-bearing: a default build validates, an override
 * applies, and the same context always produces the same bytes. Everything downstream —
 * fixtures, the file store's tests (WP-02), an adopter's integration tests — assumes all three.
 */

import {
  SCHEMA_VERSION,
  listSchemaNames,
  parseEpisodeId,
  parseId,
  validate,
  type SchemaName,
} from "@aldus/core";
import { describe, expect, it } from "vitest";

import {
  buildActorRef,
  buildArtifactRef,
  buildCostRecord,
  buildEpisodeRef,
  buildFor,
  buildGateDecision,
  buildInvalid,
  buildRunManifest,
  buildStageAttempt,
  buildStageExecution,
  builders,
  omit,
} from "../src/builders.js";
import {
  DEFAULT_TEST_SEED,
  TEST_EPOCH_ISO,
  TEST_EPOCH_MS,
  createSeededBytes,
  createTestClock,
  createTestContext,
  createTestIdFactory,
  testDigest,
} from "../src/clock.js";

const schemaNames = listSchemaNames();

/* -------------------------------------------------------------------------------------------
 * Determinism
 * ---------------------------------------------------------------------------------------- */

describe("test clock", () => {
  it("starts frozen at the synthetic epoch", () => {
    const clock = createTestClock();
    expect(clock.nowIso()).toBe(TEST_EPOCH_ISO);
    expect(clock.now()).toBe(TEST_EPOCH_MS);
    expect(clock.now()).toBe(clock.now());
  });

  it("advances only when told to", () => {
    const clock = createTestClock();
    clock.advance(5 * 60_000);
    expect(clock.nowIso()).toBe("2026-01-01T00:05:00.000Z");
  });

  it("refuses to rewind via advance, which would hide ordering bugs", () => {
    const clock = createTestClock();
    expect(() => clock.advance(-1)).toThrowError(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrowError(RangeError);
  });

  it("jumps to an absolute instant via set", () => {
    const clock = createTestClock();
    clock.set("2027-06-05T04:03:02.001Z");
    expect(clock.nowIso()).toBe("2027-06-05T04:03:02.001Z");
  });

  it("rejects an unparseable instant", () => {
    expect(() => createTestClock("not-a-date")).toThrowError(RangeError);
  });
});

describe("seeded byte source", () => {
  it("produces the same bytes for the same seed", () => {
    expect([...createSeededBytes(7)(16)]).toEqual([...createSeededBytes(7)(16)]);
  });

  it("produces different bytes for different seeds", () => {
    expect([...createSeededBytes(7)(16)]).not.toEqual([...createSeededBytes(8)(16)]);
  });

  it("yields byte values, not truncated words", () => {
    const bytes = createSeededBytes(DEFAULT_TEST_SEED)(64);
    expect(bytes).toHaveLength(64);
    for (const byte of bytes) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
    // A generator stuck on one value would still satisfy the bounds above.
    expect(new Set(bytes).size).toBeGreaterThan(8);
  });
});

describe("deterministic identity", () => {
  // Pinned to literals. A determinism claim that nothing pins is not a guarantee — it just
  // means two equally-wrong values agreed with each other.
  it("mints an exact, reproducible ID sequence", () => {
    const ids = createTestIdFactory();
    expect(ids.newRunId()).toBe("run_01KDVDNA00KN0WFMWD332BG83R");
    expect(ids.newRunId()).toBe("run_01KDVDNA00KN0WFMWD332BG83S");
    expect(ids.newArtifactId()).toBe("art_01KDVDNA00KN0WFMWD332BG83T");
  });

  it("gives two fresh contexts the identical sequence", () => {
    expect(createTestContext().ids.newRunId()).toBe(createTestContext().ids.newRunId());
  });

  it("gives a different seed a different sequence", () => {
    expect(createTestContext({ seed: 99 }).ids.newRunId()).not.toBe(
      createTestContext().ids.newRunId(),
    );
  });

  it("mints IDs that Core can parse and that sort by creation order", () => {
    const ids = createTestIdFactory();
    const first = ids.newRunId();
    const second = ids.newRunId();
    const parsed = parseId(first);
    expect(parsed?.prefix).toBe("run");
    expect(parsed?.timestamp).toBe(TEST_EPOCH_MS);
    // Monotonic within a frozen millisecond: the randomness increments rather than redrawing.
    expect(second > first).toBe(true);
  });
});

describe("testDigest", () => {
  it("is stable for a seed", () => {
    expect(testDigest("a")).toBe(testDigest("a"));
  });

  it("differs across seeds", () => {
    expect(testDigest("a")).not.toBe(testDigest("b"));
  });

  it("satisfies Core's lowercase-hex digest constraint", () => {
    expect(testDigest("artifact:canonical-script")).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* -------------------------------------------------------------------------------------------
 * Builders
 * ---------------------------------------------------------------------------------------- */

describe("builder registry", () => {
  it("covers every registered core schema", () => {
    expect(Object.keys(builders).sort()).toEqual(schemaNames.sort());
  });

  // Asserted in a loop rather than eleven times by hand, so a twelfth schema that arrives
  // without a builder fails here instead of being quietly untested.
  it.each(schemaNames)("%s builds a record that validates unmodified", (name) => {
    const record = builders[name](undefined, createTestContext());
    const result = validate(name, record);
    if (!result.ok) {
      throw new Error(`${name}: ${JSON.stringify(result.error.details, null, 2)}`);
    }
    expect(result.ok).toBe(true);
  });

  it.each(schemaNames)("buildFor(%s) validates its own output", (name) => {
    expect(() => buildFor(name)).not.toThrow();
  });

  it("stamps the current schema version on standalone documents", () => {
    for (const name of [
      "EpisodeRef",
      "RunManifest",
      "ArtifactRef",
    ] as const satisfies SchemaName[]) {
      const record = builders[name](undefined, createTestContext()) as { schemaVersion: string };
      expect(record.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });
});

describe("determinism through builders", () => {
  it("produces identical records from two identical contexts", () => {
    expect(buildRunManifest(undefined, createTestContext())).toEqual(
      buildRunManifest(undefined, createTestContext()),
    );
  });

  it("produces different records from differently seeded contexts", () => {
    expect(buildRunManifest(undefined, createTestContext())).not.toEqual(
      buildRunManifest(undefined, createTestContext({ seed: 4242 })),
    );
  });

  it("reads timestamps from the injected clock", () => {
    const context = createTestContext({ startIso: "2030-03-03T03:03:03.000Z" });
    expect(buildRunManifest(undefined, context).createdAt).toBe("2030-03-03T03:03:03.000Z");
  });

  it("draws successive IDs from one shared context", () => {
    const context = createTestContext();
    const first = buildArtifactRef(undefined, context).artifactId;
    const second = buildArtifactRef(undefined, context).artifactId;
    expect(first).not.toBe(second);
  });
});

describe("overrides", () => {
  it("replaces a scalar field", () => {
    expect(buildEpisodeRef({ showId: "example-show-b" }).showId).toBe("example-show-b");
  });

  it("ignores an explicitly undefined value rather than deleting the default", () => {
    // Under exactOptionalPropertyTypes an explicit undefined is a different shape from an
    // absent key; "not overridden" must not quietly become "present and undefined".
    const record = buildEpisodeRef({ title: undefined });
    expect(record.title).toBe("Example Episode A");
    expect(Object.hasOwn(record, "title")).toBe(true);
  });

  it("replaces a nested record supplied whole", () => {
    const episode = buildEpisodeRef({
      showId: "example-show-c",
      episodeId: "show:example-show-c:episode:episode-z",
    });
    const run = buildRunManifest({ episode });
    expect(run.episode.showId).toBe("example-show-c");
    expect(validate("RunManifest", run).ok).toBe(true);
  });

  it("keeps the record valid after an override", () => {
    const record = buildCostRecord({ billingStatus: "unknown" });
    expect(validate("CostRecord", record).ok).toBe(true);
  });

  it("removes a field only through omit, never through an undefined override", () => {
    // `{ actual: undefined }` is ignored by design, so it must NOT drop the field. Dropping it
    // requires omit — and the record stays valid because `estimated` still satisfies the
    // at-least-one-amount refinement (contract §19.3).
    const kept = buildCostRecord({ actual: undefined });
    expect(Object.hasOwn(kept, "actual")).toBe(true);

    const dropped = omit(buildCostRecord(), "actual");
    expect(Object.hasOwn(dropped, "actual")).toBe(false);
    expect(validate("CostRecord", dropped).ok).toBe(true);

    // Removing both amounts trips the refinement JSON Schema cannot express.
    const empty = omit(buildCostRecord(), "actual", "estimated");
    expect(validate("CostRecord", empty).ok).toBe(false);
  });
});

describe("composition", () => {
  it("builds a Run whose embedded Episode validates on its own", () => {
    const run = buildRunManifest(undefined, createTestContext());
    expect(validate("EpisodeRef", run.episode).ok).toBe(true);
    expect(parseEpisodeId(run.episode.episodeId)).toEqual({
      showId: "example-show",
      episodeSlug: "episode-a",
    });
  });

  it("builds a Run whose embedded pack references validate on their own", () => {
    const run = buildRunManifest(undefined, createTestContext());
    for (const pack of run.knowledgePacks) {
      expect(validate("KnowledgePackRef", pack).ok).toBe(true);
    }
  });

  it("builds a Stage Execution with strictly ascending attempt ordinals", () => {
    const execution = buildStageExecution(undefined, createTestContext());
    expect(execution.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(validate("StageExecution", execution).ok).toBe(true);
  });

  it("builds attempts whose artifacts validate on their own", () => {
    const attempt = buildStageAttempt(undefined, createTestContext());
    for (const artifact of [...attempt.inputArtifacts, ...attempt.outputArtifacts]) {
      expect(validate("ArtifactRef", artifact).ok).toBe(true);
    }
  });
});

describe("negative-test helpers", () => {
  it("buildInvalid damages exactly one field", () => {
    const record = buildInvalid(buildArtifactRef, (artifact) => ({
      ...artifact,
      sha256: "not-a-digest",
    }));
    const result = validate("ArtifactRef", record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issues = (result.error.details?.issues ?? []) as Array<{ path: string }>;
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("sha256");
    }
  });

  it("omit removes a required field", () => {
    const record = omit(buildGateDecision(undefined, createTestContext()), "expiresOnChange");
    const result = validate("GateDecision", record);
    expect(result.ok).toBe(false);
  });

  it("leaves the builder's own output untouched", () => {
    const context = createTestContext();
    const pristine = buildActorRef(undefined, context);
    omit(pristine, "id");
    expect(pristine.id).toBe("operator-a");
  });
});

describe("boundary (contract §4.2)", () => {
  // The builders are part of the distribution's test corpus. Contract §19.2 forbids Core tests
  // from requiring private packs, and §4.2 keeps provider, platform, and adopter identities out
  // of Core entirely.
  //
  // The forbidden names are assembled from fragments rather than written out. The CI `boundary`
  // job greps `packages/` for those literals, so spelling them here would fail the very check
  // this test mirrors — a test that cannot coexist with its own enforcement is not much of a
  // test.
  const forbiddenNames = [
    ["eleven", "labs"],
    ["open", "ai"],
    ["you", "tube"],
    ["spot", "ify"],
    ["fire", "store"],
  ].map((fragments) => fragments.join(""));

  it("names no provider, platform, or cloud service", () => {
    const serialised = JSON.stringify(
      schemaNames.map((name) => builders[name](undefined, createTestContext())),
    ).toLowerCase();
    for (const forbidden of forbiddenNames) {
      expect(serialised, `a builder default leaks "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("uses transparently fictional identities instead", () => {
    const serialised = JSON.stringify(
      schemaNames.map((name) => builders[name](undefined, createTestContext())),
    );
    expect(serialised).toContain("example-show");
    expect(serialised).toContain("provider-a");
    expect(serialised).toContain("destination-a");
  });
});
