import { describe, expect, it } from "vitest";

import {
  AldusError,
  CoreErrorCodes,
  ERROR_CATEGORIES,
  MAX_ERROR_CAUSE_DEPTH,
  type StructuredError,
  structuredErrorSchema,
  toStructuredError,
  truncateCauses,
} from "../src/errors.js";

const minimal: StructuredError = {
  code: "ALDUS_EXAMPLE_FAILURE",
  category: "io",
  message: "Could not read the run manifest.",
  retryable: true,
};

describe("structuredErrorSchema", () => {
  it("accepts a minimal error", () => {
    expect(structuredErrorSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts a fully populated error with a nested cause chain", () => {
    const full: StructuredError = {
      ...minimal,
      details: { path: "runs/run_01/run.json" },
      occurredAt: "2026-08-18T10:00:00Z",
      causes: [{ ...minimal, code: "ALDUS_INNER", causes: [{ ...minimal, code: "ALDUS_ROOT" }] }],
    };
    expect(structuredErrorSchema.safeParse(full).success).toBe(true);
  });

  it.each(ERROR_CATEGORIES)("accepts category %s", (category) => {
    expect(structuredErrorSchema.safeParse({ ...minimal, category }).success).toBe(true);
  });

  it("rejects an unknown category", () => {
    expect(structuredErrorSchema.safeParse({ ...minimal, category: "oops" }).success).toBe(false);
  });

  it("rejects a missing retryable flag", () => {
    const { retryable: _omitted, ...withoutRetryable } = minimal;
    expect(structuredErrorSchema.safeParse(withoutRetryable).success).toBe(false);
  });

  it("rejects a timestamp without an offset", () => {
    expect(
      structuredErrorSchema.safeParse({ ...minimal, occurredAt: "2026-08-18T10:00:00" }).success,
    ).toBe(false);
  });
});

describe("AldusError", () => {
  it("defaults retryability from the category", () => {
    expect(new AldusError("X", "m", { category: "io" }).retryable).toBe(true);
    expect(new AldusError("X", "m", { category: "provider" }).retryable).toBe(true);
    expect(new AldusError("X", "m", { category: "timeout" }).retryable).toBe(true);
    expect(new AldusError("X", "m", { category: "validation" }).retryable).toBe(false);
    expect(new AldusError("X", "m", { category: "policy" }).retryable).toBe(false);
    expect(new AldusError("X", "m", { category: "cancelled" }).retryable).toBe(false);
  });

  it("honours an explicit retryable override", () => {
    expect(new AldusError("X", "m", { category: "io", retryable: false }).retryable).toBe(false);
  });

  it("is a real Error, so it survives instanceof and try/catch", () => {
    const error = new AldusError("X", "boom", { category: "internal" });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AldusError);
    expect(error.name).toBe("AldusError");
    expect(error.message).toBe("boom");
    expect(error.stack).toBeTruthy();
  });

  // exactOptionalPropertyTypes is on: absent optionals must be genuinely absent, not
  // present-and-undefined, or a JSON round-trip changes the record's shape.
  it("omits absent optional fields rather than setting them to undefined", () => {
    const structured = new AldusError("X", "m", { category: "internal" }).toStructuredError();
    expect(Object.keys(structured).sort()).toEqual(["category", "code", "message", "retryable"]);
  });

  it("produces a structured error that validates against the schema", () => {
    const structured = new AldusError(CoreErrorCodes.ID_INVALID, "bad id", {
      category: "validation",
      details: { received: "nope" },
      occurredAt: "2026-08-18T10:00:00Z",
      causes: [minimal],
    }).toStructuredError();
    expect(structuredErrorSchema.safeParse(structured).success).toBe(true);
  });

  it("serialises to its structured form via JSON.stringify", () => {
    const error = new AldusError("X", "m", { category: "internal" });
    expect(JSON.parse(JSON.stringify(error))).toEqual(error.toStructuredError());
  });

  it("truncates an over-deep cause chain at construction time", () => {
    const deep = (depth: number): StructuredError =>
      depth === 0 ? minimal : { ...minimal, causes: [deep(depth - 1)] };
    const error = new AldusError("X", "m", { category: "internal", causes: [deep(10)] });

    let level = 0;
    let node: StructuredError | undefined = error.causes?.[0];
    while (node !== undefined) {
      level += 1;
      node = node.causes?.[0];
    }
    expect(level).toBe(MAX_ERROR_CAUSE_DEPTH);
  });
});

describe("truncateCauses", () => {
  it("leaves a chain within the limit untouched", () => {
    const causes = [{ ...minimal, causes: [minimal] }];
    expect(truncateCauses(causes)).toEqual(causes);
  });

  it("drops nesting beyond the requested depth", () => {
    const causes = [{ ...minimal, causes: [{ ...minimal, causes: [minimal] }] }];
    const truncated = truncateCauses(causes, 2);
    expect(truncated[0]?.causes?.[0]?.causes).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const causes = [{ ...minimal, causes: [{ ...minimal, causes: [minimal] }] }];
    const snapshot = structuredClone(causes);
    truncateCauses(causes, 1);
    expect(causes).toEqual(snapshot);
  });
});

describe("toStructuredError", () => {
  it("passes an AldusError through unchanged", () => {
    const error = new AldusError("X", "m", { category: "conflict" });
    expect(toStructuredError(error)).toEqual(error.toStructuredError());
  });

  it("wraps a native Error, recording its constructor name", () => {
    const structured = toStructuredError(new TypeError("bad type"));
    expect(structured.code).toBe("ALDUS_UNEXPECTED_ERROR");
    expect(structured.category).toBe("internal");
    expect(structured.message).toBe("bad type");
    expect(structured.details).toEqual({ errorName: "TypeError" });
  });

  it("handles a thrown string", () => {
    expect(toStructuredError("plain failure").message).toBe("plain failure");
  });

  it.each([[null], [undefined], [42], [{ not: "an error" }]])(
    "handles a thrown non-error value (%s)",
    (thrown) => {
      const structured = toStructuredError(thrown);
      expect(structured.message).toBe("Non-error value was thrown.");
      expect(structuredErrorSchema.safeParse(structured).success).toBe(true);
    },
  );

  it("honours a caller-supplied fallback classification", () => {
    const structured = toStructuredError(new Error("upstream refused"), {
      code: "ALDUS_UPSTREAM_REFUSED",
      category: "provider",
    });
    expect(structured.code).toBe("ALDUS_UPSTREAM_REFUSED");
    expect(structured.category).toBe("provider");
    expect(structured.retryable).toBe(true);
  });
});

describe("CoreErrorCodes", () => {
  it("uses stable ALDUS_-prefixed SCREAMING_SNAKE codes", () => {
    for (const code of Object.values(CoreErrorCodes)) {
      expect(code).toMatch(/^ALDUS_[A-Z0-9_]+$/);
    }
  });

  it("has no duplicate values", () => {
    const values = Object.values(CoreErrorCodes);
    expect(new Set(values).size).toBe(values.length);
  });
});
