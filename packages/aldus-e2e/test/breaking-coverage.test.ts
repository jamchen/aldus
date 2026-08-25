import { describe, expect, it } from "vitest";

import {
  parseWaivers,
  selectSection,
  uncoveredFindings,
} from "../../../scripts/breaking-coverage.mjs";

/**
 * Regression cases for the breaking-notes admission rule.
 *
 * Every case here is a **false green** the first implementation allowed. They were found by review,
 * not by use, and the review's sharpest point was that the four cases validating that version lived
 * in a PR body: review evidence is not a gate, and a green CI that never exercises the holes says
 * nothing about them.
 */

const FINDING = "newly required member: aldus-gate-engine:SpendGrant.scope";
const SYMBOL = "aldus-gate-engine:SpendGrant.scope";

const changelogWith = (heading: string, body: string): string =>
  `# Changelog\n\n## ${heading}\n\n${body}\n\n## 0.1.0 — 2026-08-18\n\nold notes.\n`;

describe("selectSection", () => {
  it("binds a version to its own heading", () => {
    const changelog = changelogWith("0.2.0-next.23 — 2026-08-25", "### BREAKING\n\nnotes.");
    expect(selectSection(changelog, "0.2.0-next.23").heading).toBe("0.2.0-next.23 — 2026-08-25");
  });

  it("does not let a prefix bind to a different release", () => {
    // `0.2.0-next.2`.startsWith-matching `0.2.0-next.20` accepts another release's notes wholesale.
    const changelog = changelogWith("0.2.0-next.20 — 2026-08-20", "### BREAKING\n\nnotes.");
    const selected = selectSection(changelog, "0.2.0-next.2");
    expect(selected.heading).not.toBe("0.2.0-next.20 — 2026-08-20");
  });

  it("falls back to Unreleased, never to a previous version's heading", () => {
    const changelog = `# Changelog\n\n## Unreleased\n\npending.\n\n## 0.2.0-next.20 — 2026-08-20\n\n### BREAKING\n\nold.\n`;
    expect(selectSection(changelog, "0.2.0-next.23").heading).toBe("Unreleased");
  });

  it("reports no heading when neither exists", () => {
    const changelog = `# Changelog\n\n## 0.1.0 — 2026-08-18\n\nold.\n`;
    expect(selectSection(changelog, "0.2.0-next.23").heading).toBeUndefined();
  });
});

describe("parseWaivers", () => {
  it("accepts a waiver carrying a reason", () => {
    const { waived, malformed } = parseWaivers(
      `<!-- breaking-waiver: ${SYMBOL} — internal only -->`,
    );
    expect(malformed).toEqual([]);
    expect(waived.get(SYMBOL)).toBe("internal only");
  });

  it("refuses a waiver with no reason rather than accepting it leniently", () => {
    // The documented form requires a reason. Accepting one without makes the requirement
    // decorative, which is the failure the gate exists to prevent.
    const { waived, malformed } = parseWaivers(`<!-- breaking-waiver: ${SYMBOL} -->`);
    expect(waived.size).toBe(0);
    expect(malformed).toHaveLength(1);
  });

  it("reads only the section it is given, so an old waiver cannot excuse a new finding", () => {
    // The caller passes the selected section; a waiver in a previous release is simply not in it.
    const { waived } = parseWaivers("### BREAKING\n\nnotes with no waiver.");
    expect(waived.size).toBe(0);
  });
});

describe("uncoveredFindings", () => {
  const empty = new Map<string, string>();

  it("counts a finding as covered only when explicitly marked", () => {
    const body = `### BREAKING\n\nmigration prose.\n\n<!-- breaking: ${SYMBOL} -->`;
    expect(uncoveredFindings([FINDING], body, empty)).toEqual([]);
  });

  it("does not accept a BREAKING heading that names nothing", () => {
    expect(uncoveredFindings([FINDING], "### BREAKING\n\nsomething changed.", empty)).toEqual([
      FINDING,
    ]);
  });

  it("does not accept the symbol's parts appearing in unrelated prose", () => {
    // The previous rule asked whether each dotted part appeared anywhere in the section, so a type
    // name in one paragraph and a member name in another satisfied the whole symbol.
    const body = "### BREAKING\n\n`SpendGrant` gained something.\n\nSeparately, `scope` is a word.";
    expect(uncoveredFindings([FINDING], body, empty)).toEqual([FINDING]);
  });

  it("documents one finding without covering the rest", () => {
    const other = "removed export: aldus-gate-engine:grantLimitsDigest";
    const body = `### BREAKING\n\n<!-- breaking: ${SYMBOL} -->`;
    expect(uncoveredFindings([FINDING, other], body, empty)).toEqual([other]);
  });

  it("treats a reasoned waiver as coverage", () => {
    const waived = new Map([[SYMBOL, "internal only"]]);
    expect(uncoveredFindings([FINDING], "### BREAKING\n\nnotes.", waived)).toEqual([]);
  });
});
