/**
 * Package entry-point completeness.
 *
 * `builders` is a registry keyed by schema name, and its `satisfies` clause already fails to
 * compile if a schema has no builder. What it does not catch is a builder that exists, is
 * registered, and is simply never re-exported from `index.ts` — `builders.AldusEvent(...)` keeps
 * working while `import { buildAldusEvent } from "@aldus/testkit"` fails.
 *
 * That is exactly what happened when AldusEvent was added, and nothing noticed until a consumer
 * tried the named import. This closes it.
 */

import { describe, expect, it } from "vitest";

import * as testkit from "../src/index.js";
import { builders } from "../src/builders.js";

describe("package entry point", () => {
  it("exports a named builder for every registered schema", () => {
    const missing = Object.keys(builders)
      .map((name) => `build${name}`)
      .filter((exportName) => !Object.hasOwn(testkit, exportName));
    expect(missing, "registered builders that index.ts does not re-export").toEqual([]);
  });

  it("exports the registry itself", () => {
    expect(testkit.builders).toBe(builders);
  });
});
