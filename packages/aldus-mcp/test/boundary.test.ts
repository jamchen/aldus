/**
 * The Core boundary (contract §4.2, §4.3).
 *
 * Aldus Core and its packages name no provider, platform, cloud service, or adopter identity.
 * CI greps `packages/` for those names, and this suite mirrors that check over the surface an
 * agent actually reads — tool names, titles, descriptions, and argument schemas — because that
 * text is where an adopter concept would most plausibly be introduced as a convenience.
 *
 * The forbidden names are assembled from fragments. Written literally they would trip the very
 * grep this file mirrors, which three earlier work packages each discovered the hard way.
 */

import { describe, expect, it } from "vitest";

import { MUTATION_TOOLS, READ_TOOLS } from "../src/tools.js";

/** Reassembled at runtime so the source text contains none of them. */
const FORBIDDEN = [
  ["eleven", "labs"],
  ["open", "ai"],
  ["anthro", "pic"],
  ["you", "tube"],
  ["spot", "ify"],
  ["sound", "cloud"],
  ["fire", "store"],
  ["apple", "podcast"],
].map(([head, tail]) => `${head ?? ""}${tail ?? ""}`);

/** Every string an agent could read off the tool surface. */
function surfaceText(): string {
  return [...READ_TOOLS, ...MUTATION_TOOLS]
    .map((tool) =>
      [tool.name, tool.title, tool.description, JSON.stringify(tool.inputSchema)].join(" "),
    )
    .join(" ")
    .toLowerCase();
}

describe("the tool surface stays generic (§4.2)", () => {
  it("names no provider, platform, or cloud service", () => {
    const text = surfaceText();
    for (const name of FORBIDDEN) {
      expect(text.includes(name), `the tool surface mentions "${name}"`).toBe(false);
    }
  });

  it("has assembled real names to check against", () => {
    // Without this the loop above could pass because the list was empty or mangled.
    expect(FORBIDDEN).toHaveLength(8);
    expect(FORBIDDEN.every((name) => name.length > 4)).toBe(true);
  });

  it("names no show, host, or brand in its examples", () => {
    const text = surfaceText();
    for (const term of ["example-show", "example-host"]) {
      // Fictional placeholders belong in fixtures, not in text an agent reads as guidance.
      expect(text.includes(term)).toBe(false);
    }
  });

  it("describes destinations and providers only as caller-supplied concepts", () => {
    // §4.2: anything provider- or platform-shaped is an opaque string the caller supplies. No
    // tool argument may enumerate them.
    for (const tool of [...READ_TOOLS, ...MUTATION_TOOLS]) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema).not.toMatch(/"enum":\s*\[[^\]]*(provider|destination|platform)/i);
    }
  });
});
