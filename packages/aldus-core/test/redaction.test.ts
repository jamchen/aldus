import { describe, expect, it } from "vitest";

import type { StructuredError } from "../src/errors.js";
import { ID_PREFIX_VALUES } from "../src/ids.js";
import {
  DEFAULT_MAX_ARRAY_LENGTH,
  DEFAULT_MAX_DEPTH,
  DEFAULT_REDACTION_PLACEHOLDER,
  DEFAULT_SENSITIVE_KEY_PATTERNS,
  DEFAULT_SENSITIVE_VALUE_PATTERNS,
  isSensitiveKey,
  redact,
  redactError,
  redactHeaders,
  redactRecord,
  redactUri,
} from "../src/redaction.js";

const PLACEHOLDER = DEFAULT_REDACTION_PLACEHOLDER;
const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("isSensitiveKey", () => {
  it("matches credential-bearing key names", () => {
    for (const key of [
      "token",
      "accessToken",
      "refresh_token",
      "secret",
      "clientSecret",
      "password",
      "passwd",
      "pwd",
      "passphrase",
      "apiKey",
      "api_key",
      "API-KEY",
      "privateKey",
      "accessKey",
      "sessionId",
      "session_token",
      "Authorization",
      "authHeader",
      "auth",
      "Cookie",
      "set-cookie",
      "credential",
      "credentials",
      "signature",
      "requestSig",
      "x-sig",
      "hmacSalt",
      "bearer",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("leaves load-bearing contract fields alone", () => {
    // Each of these is a real field in the architecture contract. Redacting any of them would
    // corrupt state rather than protect it.
    for (const key of [
      "idempotencyKey", // ReleaseReceipt (§17) — required for resumable publishing
      "authority", // KnowledgePackRef (§9.1) — drives pack precedence
      "author",
      "sha256", // ArtifactRef (§8) — artifact identity
      "subjectHashes", // GateDecision (§13) — binds an approval to exact inputs
      "inputHashes",
      "uri",
      "kind",
      "mediaType",
      "producerRunId",
      "reconstructability",
      "backendId",
      "displayName",
      "workflowVersion",
      "codeRevision",
      "currency",
      "billingStatus",
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("honours allowKeys over the patterns", () => {
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("apiKey", { allowKeys: ["apikey"] })).toBe(false);
    expect(isSensitiveKey("apiKey", { allowKeys: ["APIKEY"] })).toBe(false);
  });

  it("extends rather than replaces when given additionalKeyPatterns", () => {
    expect(isSensitiveKey("customField", { additionalKeyPatterns: [/custom/i] })).toBe(true);
    expect(isSensitiveKey("token", { additionalKeyPatterns: [/custom/i] })).toBe(true);
  });

  it("replaces the defaults when given keyPatterns", () => {
    expect(isSensitiveKey("token", { keyPatterns: [/custom/i] })).toBe(false);
    expect(isSensitiveKey("customField", { keyPatterns: [/custom/i] })).toBe(true);
  });

  it("stays correct across repeated calls even if a pattern carries the g flag", () => {
    const options = { additionalKeyPatterns: [/sticky/g] };
    for (let index = 0; index < 5; index += 1) {
      expect(isSensitiveKey("stickyField", options)).toBe(true);
      expect(isSensitiveKey("token", options)).toBe(true);
    }
  });

  it("exposes the default patterns for extension rather than forking", () => {
    expect(DEFAULT_SENSITIVE_KEY_PATTERNS.length).toBeGreaterThan(0);
    expect(DEFAULT_SENSITIVE_VALUE_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("redact — key-based", () => {
  it("replaces the whole value without recursing into it", () => {
    const result = redact({
      apiKey: { nested: { deeply: "secret-value" } },
      credentials: ["a", "b"],
      note: "safe",
    });
    expect(result).toEqual({
      apiKey: PLACEHOLDER,
      credentials: PLACEHOLDER,
      note: "safe",
    });
  });

  it("redacts nested occurrences", () => {
    expect(redact({ outer: { inner: { password: "hunter2", keep: 1 } } })).toEqual({
      outer: { inner: { password: PLACEHOLDER, keep: 1 } },
    });
  });
});

describe("redact — value-shape", () => {
  it("redacts bearer and basic credentials wherever they appear", () => {
    expect(redact({ note: "send Bearer abc123DEF456ghi789 upstream" })).toEqual({
      note: `send ${PLACEHOLDER} upstream`,
    });
    expect(redact({ note: "Basic YWxhZGRpbjpvcGVuc2VzYW1l" })).toEqual({ note: PLACEHOLDER });
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redact({ blob: jwt })).toEqual({ blob: PLACEHOLDER });
  });

  it("redacts a PEM private key through to the end of the value", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    const result = redact({ blob: `prefix ${pem}` }) as Record<string, string>;
    expect(result["blob"]).toBe(`prefix ${PLACEHOLDER}`);
    expect(result["blob"]).not.toContain("MIIabc");
  });

  it("redacts a long mixed-case high-entropy value", () => {
    expect(redact({ note: `aB3${"x".repeat(40)}` })).toEqual({ note: PLACEHOLDER });
  });

  it("never redacts a SHA-256 digest, whatever the case", () => {
    // Hashes are load-bearing identity (§8, §13). Destroying one is worse than the leak the
    // entropy heuristic would be preventing.
    expect(redact({ sha256: SHA256 })).toEqual({ sha256: SHA256 });
    expect(redact({ digest: SHA256 })).toEqual({ digest: SHA256 });
    expect(redact({ digest: SHA256.toUpperCase() })).toEqual({ digest: SHA256.toUpperCase() });
    expect(redact({ inputHashes: [SHA256, SHA256] })).toEqual({
      inputHashes: [SHA256, SHA256],
    });
  });

  it("never eats a domain-shaped value that merely looks long and mixed", () => {
    // The entropy heuristic requires an unbroken alphanumeric run. Every value here is long and
    // mixed-case but separator-rich, which is what real production text looks like. Redacting
    // any of these would destroy production trace (§20) rather than protect anything.
    const record = {
      filename: "episode-01-final-mix-master-v3-APPROVED.wav",
      path: "/Users/someone/workspace/artifacts/Take-03-Final.wav",
      uri: "file:///Users/someone/.aldus/runs/artifacts/Take-03-Final.wav",
      title: "Episode 42 — The Long And Winding Road To Production",
      workflow: "Interactive-Editorial-Profile-V1",
    };
    expect(redact(record)).toEqual(record);
  });

  it("never eats an entity ID minted by this package", () => {
    // Tripwire: the longest entity ID is a 4-character prefix plus 26 ULID characters. The `_`
    // separator breaks the alphanumeric run, and a ULID has no lowercase, so neither half can
    // satisfy the heuristic. If a future prefix or ID format changes that, this fails loudly.
    for (const prefix of ID_PREFIX_VALUES) {
      const id = `${prefix}_01HF7YATZZZZZZZZZZZZZZZZZZ`;
      expect(redact({ id }), id).toEqual({ id });
    }
  });

  it("leaves ordinary prose and identifiers untouched", () => {
    const record = {
      episodeId: "show:example-show:episode:ep-01",
      runId: "run_01HF7YAT000000000000000000",
      comment: "The pacing in the second segment felt rushed.",
      uri: "file:///workspace/artifacts/take-03.wav",
    };
    expect(redact(record)).toEqual(record);
  });

  it("redacts every occurrence, not just the first", () => {
    const result = redact({
      note: "Bearer aaaaaaaaaaaaaaaa then Bearer bbbbbbbbbbbbbbbb",
    }) as Record<string, string>;
    expect(result["note"]).toBe(`${PLACEHOLDER} then ${PLACEHOLDER}`);
  });

  it("stays correct across repeated calls", () => {
    for (let index = 0; index < 5; index += 1) {
      expect(redact({ note: "Bearer abc123DEF456ghi789" })).toEqual({ note: PLACEHOLDER });
      expect(redact({ sha256: SHA256 })).toEqual({ sha256: SHA256 });
    }
  });
});

describe("redact — structural safety", () => {
  it("replaces cycles with a marker", () => {
    const node: Record<string, unknown> = { name: "root" };
    node["self"] = node;
    expect(redact(node)).toEqual({ name: "root", self: "[Circular]" });
  });

  it("does not mistake a repeated reference for a cycle", () => {
    const shared = { value: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { value: 1 }, b: { value: 1 } });
  });

  it("truncates beyond the depth limit", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < DEFAULT_MAX_DEPTH + 3; index += 1) {
      deep = { next: deep };
    }
    expect(JSON.stringify(redact(deep))).toContain("[MaxDepth]");
    expect(redact({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({ a: { b: "[MaxDepth]" } });
  });

  it("caps array length and reports how many were dropped", () => {
    const items = Array.from({ length: DEFAULT_MAX_ARRAY_LENGTH + 5 }, (_, i) => i);
    const result = redact(items) as unknown[];
    expect(result).toHaveLength(DEFAULT_MAX_ARRAY_LENGTH + 1);
    expect(result.at(-1)).toBe("[+5 more]");
  });

  it("caps string length and states the original size", () => {
    const result = redact({ note: "a".repeat(50) }, { maxStringLength: 10 }) as Record<
      string,
      string
    >;
    expect(result["note"]).toBe("aaaaaaaaaa… [truncated, 50 chars]");
  });

  it("redacts before truncating, so a cut cannot leave half a secret", () => {
    const result = redact({ note: `Bearer ${"z".repeat(200)}` }, { maxStringLength: 20 }) as Record<
      string,
      string
    >;
    expect(result["note"]).toBe(PLACEHOLDER);
    expect(result["note"]).not.toContain("zzz");
  });

  it("handles a null-prototype object", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare["token"] = "abc";
    bare["keep"] = 1;
    expect(redact(bare)).toEqual({ token: PLACEHOLDER, keep: 1 });
  });

  it("summarises binary payloads rather than dumping them", () => {
    expect(redact({ audio: new Uint8Array(1024) })).toEqual({ audio: "[Binary 1024 bytes]" });
    expect(redact({ raw: new ArrayBuffer(8) })).toEqual({ raw: "[Binary 8 bytes]" });
  });

  it("renders the remaining exotic types JSON-safely", () => {
    const result = redact({
      when: new Date("2026-08-18T10:00:00.000Z"),
      pattern: /abc/gi,
      big: 10n,
      fn: () => undefined,
      sym: Symbol("x"),
      nothing: null,
      missing: undefined,
    }) as Record<string, unknown>;
    expect(result["when"]).toBe("2026-08-18T10:00:00.000Z");
    expect(result["pattern"]).toBe("/abc/gi");
    expect(result["big"]).toBe("10n");
    expect(result["fn"]).toBe("[Function]");
    expect(result["sym"]).toBe("[Symbol]");
    expect(result["nothing"]).toBeNull();
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("renders Error as a name and a scanned message", () => {
    expect(redact({ cause: new TypeError("Bearer abc123DEF456ghi789 rejected") })).toEqual({
      cause: { name: "TypeError", message: `${PLACEHOLDER} rejected` },
    });
  });

  it("renders a Set as an array and a Map as key/value pairs", () => {
    expect(redact(new Set(["a", "b"]))).toEqual(["a", "b"]);
    expect(redact(new Map([["token", "abc"]]))).toEqual([["token", PLACEHOLDER]]);
    expect(redact(new Map([["note", "safe"]]))).toEqual([["note", "safe"]]);
  });

  it("redactRecord preserves the record shape", () => {
    const result: Record<string, unknown> = redactRecord({ token: "abc", keep: 1 });
    expect(result).toEqual({ token: PLACEHOLDER, keep: 1 });
  });
});

describe("redactHeaders", () => {
  it("redacts sensitive header names case-insensitively", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        "X-Api-Key": "k",
        "Content-Type": "audio/wav",
      }),
    ).toEqual({
      Authorization: PLACEHOLDER,
      "X-Api-Key": PLACEHOLDER,
      "Content-Type": "audio/wav",
    });
  });

  it("accepts a Headers instance", () => {
    const headers = new Headers({ authorization: "Bearer abc", "content-type": "audio/wav" });
    expect(redactHeaders(headers)).toEqual({
      authorization: PLACEHOLDER,
      "content-type": "audio/wav",
    });
  });

  it("handles repeated header values and drops undefined ones", () => {
    expect(redactHeaders({ "set-cookie": ["a=1", "b=2"], "x-absent": undefined })).toEqual({
      "set-cookie": PLACEHOLDER,
    });
  });

  it("still scans the value of an innocuously named header", () => {
    expect(redactHeaders({ "x-note": "Bearer abc123DEF456ghi789" })).toEqual({
      "x-note": PLACEHOLDER,
    });
  });
});

describe("redactUri", () => {
  it("strips userinfo", () => {
    expect(redactUri("https://user:pw@example.test/path")).toBe("https://***@example.test/path");
  });

  it("redacts sensitive query values but keeps their names", () => {
    expect(redactUri("https://example.test/p?token=abc&kind=audio")).toBe(
      "https://example.test/p?token=REDACTED&kind=audio",
    );
  });

  it("leaves an artifact URI intact", () => {
    // §8 ArtifactRef.uri — a redacted artifact URI would break lineage inspection (§20).
    const uri = "file:///workspace/.aldus/artifacts/take-03.wav";
    expect(redactUri(uri)).toBe(uri);
  });

  it("handles a relative reference", () => {
    expect(redactUri("/artifacts/take-03.wav?apiKey=zzz")).toBe(
      "/artifacts/take-03.wav?apiKey=REDACTED",
    );
  });

  it("never throws on unparseable input", () => {
    expect(redactUri("http://[")).toBe("[UnparseableUri]");
    expect(() => redactUri("")).not.toThrow();
  });
});

describe("redactError", () => {
  it("redacts message, details, and the whole cause chain", () => {
    const error: StructuredError = {
      code: "ALDUS_PROVIDER_REJECTED",
      category: "provider",
      message: "Upstream rejected Bearer abc123DEF456ghi789",
      retryable: true,
      details: { apiKey: "k", requestId: "req-42", sha256: SHA256 },
      occurredAt: "2026-08-18T10:00:00Z",
      causes: [
        {
          code: "ALDUS_IO_FAILED",
          category: "io",
          message: "socket closed",
          retryable: true,
          details: { password: "hunter2" },
          causes: [
            {
              code: "ALDUS_INNER",
              category: "internal",
              message: "Bearer abc123DEF456ghi789",
              retryable: false,
            },
          ],
        },
      ],
    };

    const redacted = redactError(error);

    expect(redacted.message).toBe(`Upstream rejected ${PLACEHOLDER}`);
    expect(redacted.details).toEqual({
      apiKey: PLACEHOLDER,
      requestId: "req-42",
      sha256: SHA256,
    });
    expect(redacted.causes?.[0]?.details).toEqual({ password: PLACEHOLDER });
    expect(redacted.causes?.[0]?.causes?.[0]?.message).toBe(PLACEHOLDER);

    // Structural fields survive untouched — they are what makes the error actionable.
    expect(redacted.code).toBe("ALDUS_PROVIDER_REJECTED");
    expect(redacted.category).toBe("provider");
    expect(redacted.retryable).toBe(true);
    expect(redacted.occurredAt).toBe("2026-08-18T10:00:00Z");

    // The original is not mutated.
    expect(error.details).toEqual({ apiKey: "k", requestId: "req-42", sha256: SHA256 });
  });

  it("omits optional fields that were absent rather than inventing them", () => {
    const redacted = redactError({
      code: "ALDUS_X",
      category: "internal",
      message: "boom",
      retryable: false,
    });
    expect(Object.keys(redacted).sort()).toEqual(["category", "code", "message", "retryable"]);
  });

  it("leaves no trace of a credential anywhere in the serialised result", () => {
    const secret = "sk-Live-9aBcDeFgHiJkLmNoPqRsTuVwXyZ012345";
    const redacted = redactError({
      code: "ALDUS_X",
      category: "provider",
      message: `failed with ${secret}`,
      retryable: false,
      details: { authorization: `Bearer ${secret}`, note: secret },
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });
});
