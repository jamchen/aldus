import { describe, expect, it } from "vitest";

import { AldusError, CoreErrorCodes } from "../src/errors.js";
import {
  CROCKFORD_ALPHABET,
  ID_PREFIXES,
  ID_PREFIX_VALUES,
  MAX_IDENTITY_SEGMENT_LENGTH,
  MAX_ULID_TIMESTAMP,
  ULID_LENGTH,
  assertId,
  createIdFactory,
  decodeUlidTimestamp,
  formatCanonicalId,
  formatEpisodeId,
  isCanonicalId,
  isIdentitySegment,
  isUlid,
  isValidId,
  newRunId,
  parseCanonicalId,
  parseEpisodeId,
  parseId,
  slugify,
} from "../src/ids.js";

/** A factory whose clock and randomness are fully controlled by the test. */
function fixedFactory(timestamp: number, fill = 0x00) {
  let now = timestamp;
  const factory = createIdFactory({
    now: () => now,
    randomBytes: (n) => new Uint8Array(n).fill(fill),
  });
  return { factory, advance: (ms: number) => (now += ms), setNow: (ms: number) => (now = ms) };
}

describe("ULID encoding", () => {
  it("produces 26 strict Crockford Base32 characters", () => {
    const { factory } = fixedFactory(1_700_000_000_000);
    const ulid = factory.newUlid();
    expect(ulid).toHaveLength(ULID_LENGTH);
    expect(isUlid(ulid)).toBe(true);
    for (const character of ulid) {
      expect(CROCKFORD_ALPHABET).toContain(character);
    }
  });

  it("round-trips the timestamp", () => {
    for (const timestamp of [0, 1, 1_700_000_000_000, MAX_ULID_TIMESTAMP]) {
      const { factory } = fixedFactory(timestamp);
      expect(decodeUlidTimestamp(factory.newUlid())).toBe(timestamp);
    }
  });

  it("rejects the ambiguous Crockford characters I, L, O, and U", () => {
    const valid = "01HF7YAT000000000000000000";
    expect(isUlid(valid)).toBe(true);
    for (const ambiguous of ["I", "L", "O", "U"]) {
      expect(isUlid(ambiguous + valid.slice(1))).toBe(false);
    }
  });

  it("rejects lowercase rather than decoding leniently", () => {
    expect(isUlid("01hf7yat000000000000000000")).toBe(false);
  });

  it("rejects a timestamp component wider than 48 bits", () => {
    // The leading character carries the top bits; anything above '7' overflows 48 bits.
    expect(isUlid(`8${"0".repeat(25)}`)).toBe(false);
    expect(isUlid(`7${"0".repeat(25)}`)).toBe(true);
  });

  it("throws a structured error when decoding a malformed ULID", () => {
    expect(() => decodeUlidTimestamp("nope")).toThrowError(AldusError);
    try {
      decodeUlidTimestamp("nope");
      expect.unreachable();
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(AldusError);
      expect((thrown as AldusError).code).toBe(CoreErrorCodes.ID_INVALID);
    }
  });
});

describe("monotonicity", () => {
  it("increments randomness within a frozen millisecond", () => {
    const { factory } = fixedFactory(1_700_000_000_000);
    const ids = Array.from({ length: 50 }, () => factory.newRunId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts lexicographically in creation order across millisecond boundaries", () => {
    const { factory, advance } = fixedFactory(1_700_000_000_000);
    const ids: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      ids.push(factory.newRunId());
      if (index % 3 === 0) advance(1);
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it("does not emit a lower id when the clock moves backwards", () => {
    const { factory, setNow } = fixedFactory(1_700_000_000_000);
    const before = factory.newRunId();
    setNow(1_600_000_000_000);
    const after = factory.newRunId();
    expect(after > before).toBe(true);
    // The embedded timestamp is clamped, not rewound.
    expect(parseId(after)?.timestamp).toBe(1_700_000_000_000);
  });

  it("throws rather than wrapping when randomness is exhausted within a millisecond", () => {
    const { factory } = fixedFactory(1_700_000_000_000, 0xff);
    const saturated = factory.newRunId();
    expect(saturated.endsWith("Z".repeat(16))).toBe(true);

    let thrown: unknown;
    try {
      factory.newRunId();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AldusError);
    // A distinct code from ID_INVALID: nothing the caller passed was wrong, and the next
    // millisecond succeeds — so it is retryable, unlike a malformed identifier.
    expect((thrown as AldusError).code).toBe(CoreErrorCodes.ID_EXHAUSTED);
    expect((thrown as AldusError).retryable).toBe(true);
  });

  it("keeps independent factories independent", () => {
    const a = fixedFactory(1_700_000_000_000).factory;
    const b = fixedFactory(1_700_000_000_000).factory;
    expect(a.newRunId()).toBe(b.newRunId());
  });
});

describe("entity ids", () => {
  it("mints one prefix per domain concept", () => {
    const { factory } = fixedFactory(1_700_000_000_000);
    const minted: Record<string, string> = {
      run: factory.newRunId(),
      exec: factory.newStageExecutionId(),
      att: factory.newStageAttemptId(),
      art: factory.newArtifactId(),
      gate: factory.newGateId(),
      dec: factory.newGateDecisionId(),
      cost: factory.newCostId(),
      rel: factory.newReleaseId(),
    };
    for (const [prefix, id] of Object.entries(minted)) {
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(parseId(id)?.prefix).toBe(prefix);
    }
    expect(Object.keys(minted).sort()).toEqual([...ID_PREFIX_VALUES].sort());
  });

  it("parses an id into prefix, ulid, and timestamp", () => {
    const { factory } = fixedFactory(1_700_000_000_000);
    const id = factory.newArtifactId();
    expect(parseId(id)).toEqual({
      prefix: "art",
      ulid: id.slice("art_".length),
      timestamp: 1_700_000_000_000,
    });
  });

  it("returns null for malformed ids instead of throwing", () => {
    for (const candidate of [
      "",
      "_",
      "run",
      "run_",
      "_01HF7YAT000000000000000000",
      "unknown_01HF7YAT000000000000000000",
      "run_01HF7YAT00000000000000000", // 25 characters
      "run_01HF7YAT0000000000000000000", // 27 characters
      "run_01HF7YAT00000000000000000I",
    ]) {
      expect(parseId(candidate), candidate).toBeNull();
      expect(isValidId(candidate), candidate).toBe(false);
    }
  });

  it("checks the prefix when one is requested", () => {
    const { factory } = fixedFactory(1_700_000_000_000);
    const runId = factory.newRunId();
    expect(isValidId(runId, ID_PREFIXES.run)).toBe(true);
    expect(isValidId(runId, ID_PREFIXES.artifact)).toBe(false);
  });

  it("assertId throws ALDUS_ID_INVALID on the wrong prefix", () => {
    const { factory } = fixedFactory(1_700_000_000_000);
    const runId = factory.newRunId();
    expect(assertId(runId, ID_PREFIXES.run).prefix).toBe("run");
    try {
      assertId(runId, ID_PREFIXES.artifact);
      expect.unreachable();
    } catch (thrown) {
      expect((thrown as AldusError).code).toBe(CoreErrorCodes.ID_INVALID);
      expect((thrown as AldusError).details).toMatchObject({ expectedPrefix: "art" });
    }
  });

  it("rejects an unknown prefix at mint time", () => {
    const { factory } = fixedFactory(1_700_000_000_000);
    // @ts-expect-error — the prefix union exists precisely to stop this at compile time.
    expect(() => factory.newId("nope")).toThrowError(AldusError);
  });

  it("exposes process-wide helpers that produce valid ids", () => {
    expect(isValidId(newRunId(), ID_PREFIXES.run)).toBe(true);
  });
});

describe("canonical content identity", () => {
  it("builds and parses the documented episode form", () => {
    const id = formatEpisodeId("example-show", "ep-01-pilot");
    expect(id).toBe("show:example-show:episode:ep-01-pilot");
    expect(parseEpisodeId(id)).toEqual({ showId: "example-show", episodeSlug: "ep-01-pilot" });
  });

  it("builds and parses the documented series form via the general shape", () => {
    const id = formatCanonicalId({
      namespace: "series",
      namespaceId: "example-series",
      itemType: "edition",
      itemId: "2026-08",
    });
    expect(id).toBe("series:example-series:edition:2026-08");
    expect(parseCanonicalId(id)).toEqual({
      namespace: "series",
      namespaceId: "example-series",
      itemType: "edition",
      itemId: "2026-08",
    });
  });

  it("does not read an edition as an episode", () => {
    expect(parseEpisodeId("series:example-series:edition:2026-08")).toBeNull();
    expect(isCanonicalId("series:example-series:edition:2026-08")).toBe(true);
  });

  it("round-trips a CJK identity", () => {
    const slug = slugify("測試節目 第 1 集");
    const id = formatEpisodeId("範例節目", slug);
    expect(id).toBe("show:範例節目:episode:測試節目-第-1-集");
    expect(parseEpisodeId(id)).toEqual({ showId: "範例節目", episodeSlug: slug });
  });

  it("rejects the wrong number of segments", () => {
    for (const candidate of [
      "show:example-show:episode",
      "show:example-show:episode:ep-01:extra",
      "example-show",
      "",
    ]) {
      expect(parseCanonicalId(candidate), candidate).toBeNull();
    }
  });

  it("rejects segments that do not start with a letter or digit", () => {
    for (const segment of ["-leading", ".leading", "_leading", ""]) {
      expect(isIdentitySegment(segment), segment).toBe(false);
      expect(() => formatEpisodeId("example-show", segment)).toThrowError(AldusError);
    }
  });

  it("rejects an over-length segment", () => {
    const tooLong = "a".repeat(MAX_IDENTITY_SEGMENT_LENGTH + 1);
    const longest = "a".repeat(MAX_IDENTITY_SEGMENT_LENGTH);
    expect(isIdentitySegment(longest)).toBe(true);
    expect(isIdentitySegment(tooLong)).toBe(false);
    try {
      formatEpisodeId("example-show", tooLong);
      expect.unreachable();
    } catch (thrown) {
      expect((thrown as AldusError).code).toBe(CoreErrorCodes.IDENTITY_INVALID);
    }
  });

  it("rejects a segment containing the separator", () => {
    expect(() => formatEpisodeId("example-show", "ep:01")).toThrowError(AldusError);
  });

  it("rejects non-NFC input on parse so one identity cannot have two spellings", () => {
    const composed = "é"; // U+00E9
    const decomposed = "é"; // U+0065 U+0301
    expect(composed).not.toBe(decomposed);
    expect(isIdentitySegment(composed)).toBe(true);
    expect(isIdentitySegment(decomposed)).toBe(false);
    // Formatting normalises, so the two inputs converge on one canonical identity.
    expect(formatEpisodeId("example-show", decomposed)).toBe(
      formatEpisodeId("example-show", composed),
    );
  });
});

describe("slugify", () => {
  it("lowercases and folds separators", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
    expect(slugify("a - b")).toBe("a-b");
    expect(slugify("Episode   42")).toBe("episode-42");
  });

  it("drops apostrophes and quotation marks rather than splitting on them", () => {
    expect(slugify("don't stop")).toBe("dont-stop");
    expect(slugify("the “best” take")).toBe("the-best-take");
  });

  it("preserves CJK and other non-Latin scripts", () => {
    expect(slugify("測試節目")).toBe("測試節目");
    expect(slugify("тест")).toBe("тест");
    expect(slugify("Ünïcodé Tïtle")).toBe("ünïcodé-tïtle");
  });

  it("trims leading and trailing punctuation", () => {
    expect(slugify("--- hello ---")).toBe("hello");
    expect(slugify("...dots...")).toBe("dots");
  });

  it("truncates to the segment limit without leaving a trailing separator", () => {
    const slug = slugify(`${"a".repeat(MAX_IDENTITY_SEGMENT_LENGTH)} tail`);
    expect(slug).toHaveLength(MAX_IDENTITY_SEGMENT_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    expect(isIdentitySegment(slug)).toBe(true);
  });

  it("is idempotent", () => {
    for (const input of ["Hello World!", "測試節目 第 1 集", "don't -- stop", "a_b.c-d"]) {
      expect(slugify(slugify(input))).toBe(slugify(input));
    }
  });

  it("always yields a valid identity segment", () => {
    for (const input of ["Hello World!", "測試節目", "42", "a_b.c-d", "!!!x!!!"]) {
      expect(isIdentitySegment(slugify(input)), input).toBe(true);
    }
  });

  it("throws when nothing usable remains", () => {
    for (const input of ["", "   ", "---", "!!!", "。、；"]) {
      try {
        slugify(input);
        expect.unreachable();
      } catch (thrown) {
        expect((thrown as AldusError).code).toBe(CoreErrorCodes.IDENTITY_INVALID);
      }
    }
  });

  it("does not leak the input into the error, only its length", () => {
    try {
      slugify("!!!");
      expect.unreachable();
    } catch (thrown) {
      expect(JSON.stringify((thrown as AldusError).details)).not.toContain("!!!");
    }
  });

  it("survives repeated calls despite module-level global regexes", () => {
    for (let index = 0; index < 5; index += 1) {
      expect(slugify("Hello World!")).toBe("hello-world");
    }
  });
});

describe("slugify truncation (surrogate safety)", () => {
  // A plain slice cuts by UTF-16 unit. Truncating astral text at an odd offset severs a
  // surrogate pair and yields a lone surrogate: not well-formed, and rejected by the segment
  // pattern far from the place that produced it.
  const ASTRAL = "\u{20000}"; // CJK Extension B — a letter, two UTF-16 units

  it("never returns a lone surrogate when truncating astral text", () => {
    for (let lead = 0; lead < 4; lead += 1) {
      const input = "a".repeat(lead) + ASTRAL.repeat(200);
      const slug = slugify(input);
      expect(slug.isWellFormed()).toBe(true);
      expect(slug.length).toBeLessThanOrEqual(MAX_IDENTITY_SEGMENT_LENGTH);
      // The proof that matters: the result is usable as an identity segment.
      expect(isIdentitySegment(slug)).toBe(true);
      expect(() => formatEpisodeId("example-show", slug)).not.toThrow();
    }
  });

  it("preserves astral characters that fit", () => {
    const slug = slugify(ASTRAL.repeat(4));
    expect(slug).toBe(ASTRAL.repeat(4));
    expect(isIdentitySegment(slug)).toBe(true);
  });
});
