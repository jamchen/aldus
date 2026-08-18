/**
 * Manifest schema and parsing (architecture contract §9.1).
 */

import { describe, expect, it } from "vitest";

import { AldusError } from "../src/errors.js";
import { KnowledgeErrorCodes } from "../src/knowledge/errors.js";
import { knowledgePackManifestSchema } from "../src/knowledge/manifest.js";
import {
  normalizeManifestDocument,
  parsePackManifest,
  parsePackManifestDocument,
} from "../src/knowledge/parse.js";
import { SCHEMA_VERSION } from "../src/schema-version.js";
import { validate } from "../src/validate.js";

const minimal = {
  schemaVersion: SCHEMA_VERSION,
  packId: "example-global-style",
  version: "1",
  authority: "advisory" as const,
};

describe("knowledgePackManifestSchema", () => {
  it("accepts a minimal manifest", () => {
    expect(knowledgePackManifestSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts contract §9.1's example shape once its version is a string", () => {
    // The example from the architecture contract, field for field.
    const contractExample = {
      schemaVersion: SCHEMA_VERSION,
      packId: "example-show-editorial",
      version: "1",
      scope: { show: "example-show" },
      authority: "normative",
      includes: ["SOP.md", "writing-style.md"],
      tests: ["tests/example-show-editorial.test.ts"],
    };
    expect(knowledgePackManifestSchema.safeParse(contractExample).success).toBe(true);
  });

  it("is registered in the core schema registry", () => {
    const result = validate("KnowledgePackManifest", minimal);
    expect(result.ok).toBe(true);
  });

  it("gives §9.3 negative knowledge a declared home", () => {
    const parsed = knowledgePackManifestSchema.safeParse({
      ...minimal,
      negativeKnowledge: ["known-failures.md", "evaluator-blind-spots.md"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.negativeKnowledge).toHaveLength(2);
  });

  // §4.2: Core names no provider, and §9.2's dimension list is illustrative. If someone ever
  // narrows `scope` to a union, this is the test that stops it.
  it("accepts scope dimensions Core has never heard of", () => {
    const parsed = knowledgePackManifestSchema.safeParse({
      ...minimal,
      scope: {
        show: "example-show",
        "some-future-dimension": "value-a",
        anotherAxis: "value-b",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts arbitrary claim keys", () => {
    const parsed = knowledgePackManifestSchema.safeParse({
      ...minimal,
      provides: ["anything.at.all", "another/claim"],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["unknown authority", { ...minimal, authority: "mandatory" }],
    ["numeric version", { ...minimal, version: 1 }],
    ["missing packId", { schemaVersion: SCHEMA_VERSION, version: "1", authority: "advisory" }],
    ["fractional precedence", { ...minimal, precedence: 1.5 }],
    ["malformed contentHash", { ...minimal, contentHash: "not-a-digest" }],
    ["uppercase contentHash", { ...minimal, contentHash: "A".repeat(64) }],
    ["malformed schemaVersion", { ...minimal, schemaVersion: "1" }],
    ["empty packId", { ...minimal, packId: "" }],
  ])("rejects %s", (_label, document) => {
    expect(knowledgePackManifestSchema.safeParse(document).success).toBe(false);
  });

  it("does not pin schemaVersion to the current build (ADR-0003)", () => {
    // A schema accepting only its own version could never read a forward-compatible record.
    expect(
      knowledgePackManifestSchema.safeParse({ ...minimal, schemaVersion: "1.9" }).success,
    ).toBe(true);
  });
});

describe("normalizeManifestDocument", () => {
  // Contract §9.1's own example writes `version: 1`, which YAML and JSON both decode as a
  // number. Coercing it means the contract's example parses as written.
  it("coerces a numeric version to a string", () => {
    expect(normalizeManifestDocument({ version: 1 })).toEqual({ version: "1" });
  });

  it("leaves a string version alone", () => {
    expect(normalizeManifestDocument({ version: "1.0.0" })).toEqual({ version: "1.0.0" });
  });

  it("coerces nothing else", () => {
    const document = { version: "1", precedence: "100", authority: 3 };
    expect(normalizeManifestDocument(document)).toEqual(document);
  });

  it("passes non-object documents through untouched", () => {
    expect(normalizeManifestDocument(null)).toBeNull();
    expect(normalizeManifestDocument("text")).toBe("text");
    expect(normalizeManifestDocument([1, 2])).toEqual([1, 2]);
  });
});

describe("parsePackManifest", () => {
  it("parses JSON source without an injected parser", () => {
    const manifest = parsePackManifest(JSON.stringify(minimal));
    expect(manifest.packId).toBe("example-global-style");
  });

  it("accepts §9.1's bare numeric version from source", () => {
    const manifest = parsePackManifest(JSON.stringify({ ...minimal, version: 1 }));
    expect(manifest.version).toBe("1");
  });

  it("uses an injected parser for non-JSON formats", () => {
    // Core takes no YAML dependency (ADR-0006); an adopter supplies one through this hook.
    const fakeYaml = (source: string): unknown => {
      const fields = Object.fromEntries(
        source
          .trim()
          .split("\n")
          .map((line) => line.split(": ").map((part) => part.trim())),
      );
      return { schemaVersion: SCHEMA_VERSION, ...fields };
    };
    const manifest = parsePackManifest(
      "packId: example-host-voice\nversion: 3\nauthority: advisory",
      { parser: fakeYaml },
    );
    expect(manifest.packId).toBe("example-host-voice");
    expect(manifest.version).toBe("3");
  });

  it("throws ALDUS_KNOWLEDGE_MANIFEST_UNPARSEABLE on undecodable source", () => {
    let thrown: unknown;
    try {
      parsePackManifest("{ not json", { sourceRef: "packs/a/manifest.json" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AldusError);
    expect((thrown as AldusError).code).toBe(KnowledgeErrorCodes.MANIFEST_UNPARSEABLE);
    expect((thrown as AldusError).details).toMatchObject({ sourceRef: "packs/a/manifest.json" });
  });

  // §19.2: an error reaching a durable log must be safe. A manifest is authored content and
  // could contain anything a contributor pasted into it.
  it("never echoes manifest source into the unparseable error", () => {
    const secret = "sk-Example-4bK9zQm2XpL7wR3nT8vY6hJ1dS5gF0aC";
    let thrown: unknown;
    try {
      parsePackManifest(`{ broken, token: "${secret}"`);
    } catch (error) {
      thrown = error;
    }
    const serialized = JSON.stringify((thrown as AldusError).toStructuredError());
    expect(serialized).not.toContain(secret);
  });

  it("throws ALDUS_KNOWLEDGE_MANIFEST_INVALID on a decodable but invalid document", () => {
    let thrown: unknown;
    try {
      parsePackManifest(JSON.stringify({ ...minimal, authority: "mandatory" }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AldusError).code).toBe(KnowledgeErrorCodes.MANIFEST_INVALID);
  });

  it("reports the failing path without the received value", () => {
    let thrown: unknown;
    try {
      parsePackManifestDocument({ ...minimal, contentHash: "leaked-looking-value-here" });
    } catch (error) {
      thrown = error;
    }
    const serialized = JSON.stringify((thrown as AldusError).toStructuredError());
    expect(serialized).toContain("contentHash");
    expect(serialized).not.toContain("leaked-looking-value-here");
  });

  it("attaches sourceRef to a validation failure", () => {
    let thrown: unknown;
    try {
      parsePackManifestDocument({ ...minimal, packId: "" }, "packs/b/manifest.json");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AldusError).details).toMatchObject({ sourceRef: "packs/b/manifest.json" });
  });
});
