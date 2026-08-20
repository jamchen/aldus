import { describe, expect, it } from "vitest";

import { AldusError, CoreErrorCodes } from "../src/errors.js";
import {
  SCHEMA_VERSION,
  assertSchemaVersionReadable,
  checkSchemaVersion,
  compareSchemaVersions,
  formatSchemaVersion,
  isSchemaVersion,
  parseSchemaVersion,
} from "../src/schema-version.js";

describe("SCHEMA_VERSION", () => {
  it("is a well-formed MAJOR.MINOR string", () => {
    expect(isSchemaVersion(SCHEMA_VERSION)).toBe(true);
    expect(parseSchemaVersion(SCHEMA_VERSION)).toEqual({ major: 1, minor: 9 });
  });

  it("is readable by itself", () => {
    expect(checkSchemaVersion(SCHEMA_VERSION)).toBe("compatible");
  });
});

describe("parseSchemaVersion", () => {
  it("parses MAJOR.MINOR", () => {
    expect(parseSchemaVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(parseSchemaVersion("0.1")).toEqual({ major: 0, minor: 1 });
    expect(parseSchemaVersion("12.345")).toEqual({ major: 12, minor: 345 });
  });

  // A schema version is structural metadata, so rejecting ambiguous spellings up front is
  // cheaper than discovering later that "1.00" and "1.0" were treated as different versions.
  it.each([
    ["patch component", "1.0.0"],
    ["leading zero major", "01.0"],
    ["leading zero minor", "1.00"],
    ["v prefix", "v1.0"],
    ["single component", "1"],
    ["negative", "-1.0"],
    ["empty", ""],
    ["whitespace padded", " 1.0 "],
    ["non-numeric", "one.zero"],
  ])("rejects %s", (_label, value) => {
    expect(() => parseSchemaVersion(value)).toThrowError(AldusError);
    try {
      parseSchemaVersion(value);
    } catch (error) {
      expect((error as AldusError).code).toBe(CoreErrorCodes.SCHEMA_VERSION_MALFORMED);
      expect((error as AldusError).category).toBe("validation");
      expect((error as AldusError).retryable).toBe(false);
    }
  });

  it("round-trips through formatSchemaVersion", () => {
    for (const value of ["0.0", "1.0", "2.17", "99.99"]) {
      expect(formatSchemaVersion(parseSchemaVersion(value))).toBe(value);
    }
  });
});

describe("compareSchemaVersions", () => {
  it("orders by major then minor", () => {
    const v = (s: string) => parseSchemaVersion(s);
    expect(compareSchemaVersions(v("1.0"), v("1.0"))).toBe(0);
    expect(compareSchemaVersions(v("1.0"), v("1.1"))).toBe(-1);
    expect(compareSchemaVersions(v("1.1"), v("1.0"))).toBe(1);
    expect(compareSchemaVersions(v("1.99"), v("2.0"))).toBe(-1);
    expect(compareSchemaVersions(v("2.0"), v("1.99"))).toBe(1);
  });

  it("sorts a list into ascending order", () => {
    const sorted = ["2.0", "1.10", "1.2", "1.0", "10.0"]
      .map(parseSchemaVersion)
      .sort(compareSchemaVersions)
      .map(formatSchemaVersion);
    // "1.10" sorts after "1.2" — minor is numeric, not lexicographic.
    expect(sorted).toEqual(["1.0", "1.2", "1.10", "2.0", "10.0"]);
  });
});

describe("checkSchemaVersion (ADR-0003)", () => {
  it("classifies an equal or older minor as compatible", () => {
    expect(checkSchemaVersion("1.0", "1.0")).toBe("compatible");
    expect(checkSchemaVersion("1.0", "1.5")).toBe("compatible");
    expect(checkSchemaVersion("1.4", "1.5")).toBe("compatible");
  });

  // Forward is readable, not an error: otherwise every additive change would break old readers.
  it("classifies a newer minor as forward", () => {
    expect(checkSchemaVersion("1.6", "1.5")).toBe("forward");
    expect(checkSchemaVersion("1.99", "1.0")).toBe("forward");
  });

  it("classifies any differing major as incompatible", () => {
    expect(checkSchemaVersion("2.0", "1.0")).toBe("incompatible");
    expect(checkSchemaVersion("0.9", "1.0")).toBe("incompatible");
    // A newer minor cannot rescue a differing major.
    expect(checkSchemaVersion("2.99", "1.0")).toBe("incompatible");
  });

  it("defaults the supported version to this build's", () => {
    expect(checkSchemaVersion("1.0")).toBe(checkSchemaVersion("1.0", SCHEMA_VERSION));
  });

  it("rejects a malformed version on either side", () => {
    expect(() => checkSchemaVersion("nope", "1.0")).toThrowError(AldusError);
    expect(() => checkSchemaVersion("1.0", "nope")).toThrowError(AldusError);
  });
});

describe("assertSchemaVersionReadable", () => {
  it("passes and returns the classification for compatible and forward", () => {
    expect(assertSchemaVersionReadable("1.0", "1.5")).toBe("compatible");
    expect(assertSchemaVersionReadable("1.6", "1.5")).toBe("forward");
  });

  it("throws ALDUS_SCHEMA_VERSION_UNSUPPORTED across a major boundary", () => {
    try {
      assertSchemaVersionReadable("2.0", "1.0");
      expect.unreachable("expected an unsupported-version error");
    } catch (error) {
      expect(error).toBeInstanceOf(AldusError);
      const aldusError = error as AldusError;
      expect(aldusError.code).toBe(CoreErrorCodes.SCHEMA_VERSION_UNSUPPORTED);
      expect(aldusError.retryable).toBe(false);
      expect(aldusError.details).toEqual({ actual: "2.0", supported: "1.0" });
    }
  });

  it("produces a structured error that survives JSON round-tripping", () => {
    try {
      assertSchemaVersionReadable("3.1");
      expect.unreachable("expected an unsupported-version error");
    } catch (error) {
      const structured = (error as AldusError).toStructuredError();
      expect(JSON.parse(JSON.stringify(structured))).toEqual(structured);
    }
  });
});
