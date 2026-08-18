/**
 * Validation entry points (architecture contract §11) and the §19.2 value-safety guarantee.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AldusError, CoreErrorCodes } from "../src/errors.js";
import {
  assertValid,
  assertValidRecord,
  formatIssuePath,
  validate,
  validateRecord,
  validateWith,
} from "../src/validate.js";

const AT = "2026-08-18T10:00:00Z";

const episode = {
  schemaVersion: "1.0",
  episodeId: "show:example-show:episode:first-light",
  showId: "example-show",
};

describe("validate", () => {
  it("returns the parsed value on success", () => {
    const result = validate("EpisodeRef", episode);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.episodeId).toBe(episode.episodeId);
  });

  it("returns a structured error on failure", () => {
    const result = validate("EpisodeRef", { ...episode, showId: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(CoreErrorCodes.SCHEMA_VALIDATION_FAILED);
    expect(result.error.category).toBe("validation");
    expect(result.error.retryable).toBe(false);
    expect(result.error.details?.subject).toBe("EpisodeRef");
    expect(result.error.details?.issues).toEqual([
      expect.objectContaining({ path: "showId", code: "too_small" }),
    ]);
  });

  it("reports nested and indexed paths", () => {
    const result = validate("StageExecution", {
      schemaVersion: "1.0",
      runId: "run_1",
      stageId: "s",
      status: "queued",
      attempts: [
        {
          attemptId: "att_1",
          stageId: "s",
          attempt: 1,
          status: "queued",
          actor: { kind: "wrong", id: "x" },
          inputArtifacts: [],
          outputArtifacts: [],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issues = result.error.details?.issues as Array<{ path: string }>;
    expect(issues[0]?.path).toBe("attempts[0].actor.kind");
  });

  it("reports an unknown schema name", () => {
    // @ts-expect-error — deliberately probing the runtime guard with an unregistered name.
    const result = validate("NotASchema", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(CoreErrorCodes.SCHEMA_UNKNOWN);
    expect(result.error.category).toBe("not_found");
    expect(result.error.details?.known).toContain("EpisodeRef");
  });

  it("omits occurredAt rather than inventing a timestamp", () => {
    const result = validate("EpisodeRef", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.occurredAt).toBeUndefined();
  });
});

describe("value safety (§19.2)", () => {
  const CREDENTIAL = "sk-live-9f3b2c8ad41e7605bb92aa17ce4408d2";

  it("never echoes a received value into a validation error", () => {
    // The credential sits in a valid field while a different field fails, which is exactly how
    // a real leak would happen: the error describes one field but serialises the whole payload.
    const result = validate("ArtifactRef", {
      schemaVersion: "1.0",
      artifactId: CREDENTIAL,
      kind: "AudioTake",
      uri: `https://example.invalid/?token=${CREDENTIAL}`,
      sha256: "not-a-hash",
      mediaType: "audio/wav",
      producerRunId: "run_1",
      producerStageId: "synthesize",
      inputHashes: [],
      reconstructability: "irreplaceable",
      createdAt: AT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(result.error)).not.toContain("sk-live");
  });

  it("withholds a message that would have echoed input content", () => {
    // Proves the guarantee is mechanical rather than a bet on the validator's phrasing: this
    // schema deliberately interpolates the received value into its own message.
    const echoing = z
      .string()
      .superRefine((value, ctx) => ctx.addIssue({ code: "custom", message: `rejected ${value}` }));
    const result = validateWith(echoing, CREDENTIAL);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issues = result.error.details?.issues as Array<{ message: string }>;
    expect(issues[0]?.message).not.toContain(CREDENTIAL);
    expect(issues[0]?.message).toContain("withheld");
  });

  it("keeps a useful message when nothing would be echoed", () => {
    const result = validate("EpisodeRef", { ...episode, schemaVersion: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issues = result.error.details?.issues as Array<{ message: string }>;
    expect(issues[0]?.message).toContain("MAJOR.MINOR");
  });

  it("scrubs a credential nested inside an array", () => {
    const echoing = z.array(z.object({ v: z.string() })).superRefine((value, ctx) => {
      ctx.addIssue({ code: "custom", message: `saw ${value[0]?.v}` });
    });
    const result = validateWith(echoing, [{ v: CREDENTIAL }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain(CREDENTIAL);
  });
});

describe("assertValid", () => {
  it("returns the value on success", () => {
    expect(assertValid("EpisodeRef", episode).showId).toBe("example-show");
  });

  it("throws an AldusError carrying the structured error", () => {
    try {
      assertValid("EpisodeRef", {});
      expect.unreachable("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(AldusError);
      const error = thrown as AldusError;
      expect(error.code).toBe(CoreErrorCodes.SCHEMA_VALIDATION_FAILED);
      expect(error.toStructuredError().category).toBe("validation");
    }
  });
});

describe("validateRecord (ADR-0003)", () => {
  it("classifies the current version as compatible", () => {
    const result = validateRecord("EpisodeRef", episode);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.compatibility).toBe("compatible");
  });

  it("classifies a newer minor version as a forward read", () => {
    const result = validateRecord("EpisodeRef", { ...episode, schemaVersion: "1.9" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.compatibility).toBe("forward");
  });

  it("accepts unknown properties on a forward read", () => {
    // ADR-0003: unknown properties are ignored, not rejected — otherwise every additive schema
    // change would break older readers.
    const result = validateRecord("EpisodeRef", {
      ...episode,
      schemaVersion: "1.9",
      fieldFromTheFuture: { nested: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.compatibility).toBe("forward");
  });

  it("refuses a differing major version", () => {
    const result = validateRecord("EpisodeRef", { ...episode, schemaVersion: "2.0" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(CoreErrorCodes.SCHEMA_VERSION_UNSUPPORTED);
    expect(result.error.details).toMatchObject({ actual: "2.0", supported: "1.0" });
  });

  it("reports the version before reporting field errors", () => {
    // A record from an incompatible major will fail many fields; one clear cause beats a pile
    // of symptoms.
    const result = validateRecord("EpisodeRef", { schemaVersion: "3.1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(CoreErrorCodes.SCHEMA_VERSION_UNSUPPORTED);
  });

  it("falls through to field validation when the version is missing or malformed", () => {
    for (const data of [
      { episodeId: "e", showId: "s" },
      { ...episode, schemaVersion: "1" },
    ]) {
      const result = validateRecord("EpisodeRef", data);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(CoreErrorCodes.SCHEMA_VALIDATION_FAILED);
    }
  });

  it("honours an explicitly supported version", () => {
    expect(validateRecord("EpisodeRef", { ...episode, schemaVersion: "2.3" }, "2.5").ok).toBe(true);
  });
});

describe("assertValidRecord", () => {
  it("returns the value and its compatibility", () => {
    const { value, compatibility } = assertValidRecord("EpisodeRef", episode);
    expect(value.showId).toBe("example-show");
    expect(compatibility).toBe("compatible");
  });

  it("throws ALDUS_SCHEMA_VERSION_UNSUPPORTED for a differing major", () => {
    expect(() => assertValidRecord("EpisodeRef", { ...episode, schemaVersion: "2.0" })).toThrow(
      AldusError,
    );
    try {
      assertValidRecord("EpisodeRef", { ...episode, schemaVersion: "2.0" });
    } catch (thrown) {
      expect((thrown as AldusError).code).toBe(CoreErrorCodes.SCHEMA_VERSION_UNSUPPORTED);
    }
  });
});

describe("formatIssuePath", () => {
  it("renders object, array, and mixed paths", () => {
    expect(formatIssuePath([])).toBe("");
    expect(formatIssuePath(["a"])).toBe("a");
    expect(formatIssuePath(["a", "b"])).toBe("a.b");
    expect(formatIssuePath(["a", 0, "b"])).toBe("a[0].b");
    expect(formatIssuePath([0, "a"])).toBe("[0].a");
  });
});

describe("validateWith", () => {
  it("validates an arbitrary schema and honours a custom code", () => {
    const schema = z.object({ n: z.number() });
    expect(validateWith(schema, { n: 1 }).ok).toBe(true);
    const failed = validateWith(
      schema,
      { n: "x" },
      { code: "ADOPTER_BAD_INPUT", subject: "Thing" },
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("ADOPTER_BAD_INPUT");
    expect(failed.error.message).toContain("Thing");
  });
});
