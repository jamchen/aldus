/**
 * The release procedure must not name a release (ADR-0031).
 *
 * `docs/RELEASING.md` is a procedure someone follows while cutting a version. It previously
 * hardcoded `0.1.0` throughout — the version it happened to be written during — so by the fourth
 * release every command in it was wrong, and one step told the operator to expect `no latest`
 * when `latest` had existed since the bootstrap the same document describes.
 *
 * Nobody was careless. The document was correct when written and rotted while nobody was looking,
 * which is the failure ADR-0031 names and the one that writing-time care cannot reach.
 *
 * The check has to distinguish two claim forms that look identical in Markdown and have opposite
 * maintenance rules:
 *
 * - **Present-tense** — "run `npm version X`", "expect `next: X`". Must track the release being
 *   cut, so it must not name one at all; the procedure uses `${VERSION}`.
 * - **Historical** — "the `0.1.0` bootstrap got it wrong". Must *never* move. Rewriting these to
 *   match today's version would destroy the record that makes them worth having.
 *
 * A check that cannot tell them apart makes things worse than no check, so the boundary is
 * structural rather than heuristic: everything above the policy heading is procedure, everything
 * below it is history. This test enforces the first half and deliberately ignores the second.
 *
 * Reported by the first adopter, who found the same rot in three of their own documents after
 * fixing two of them by hand one release earlier.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Where history begins. Everything before this heading is a procedure to follow. */
const HISTORY_HEADING = "## Version and tag policy";

/** A release version: `1.2.3`, `0.2.0-next.4`. */
const RELEASE_VERSION = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g;

describe("the release procedure names no release (ADR-0031)", () => {
  it("carries no version literal above the policy heading", async () => {
    const text = await readFile(join(repoRoot, "docs", "RELEASING.md"), "utf8");
    const boundary = text.indexOf(HISTORY_HEADING);

    // If the heading is renamed, this test would silently start checking the whole file — or
    // nothing. Fail loudly instead: the boundary is the thing that makes the check honest.
    expect(
      boundary,
      `"${HISTORY_HEADING}" not found — the procedure/history boundary moved`,
    ).toBeGreaterThan(0);

    const procedure = text.slice(0, boundary);
    const lines = procedure.split("\n").map((line, index) => ({ line, number: index + 1 }));

    // Exactly one line may name a version: the assignment the operator edits before running
    // anything. Exempting it by pattern alone would be a hole — a second such line would slip
    // through — so the count is asserted too.
    const assignments = lines.filter((entry) => /^VERSION=/.test(entry.line.trim()));
    expect(
      assignments.length,
      "the procedure should set VERSION exactly once; a second assignment means two places to " +
        "keep in step, which is what this check exists to prevent",
    ).toBe(1);

    const offenders = lines
      .filter((entry) => !assignments.includes(entry))
      .filter((entry) => RELEASE_VERSION.test(entry.line) && !entry.line.includes("${VERSION}"))
      .map((entry) => `${entry.number}: ${entry.line.trim()}`);

    expect(
      offenders,
      "these lines name a specific release inside the procedure, so they are wrong for every " +
        "release except the one they were written during — use `${VERSION}`",
    ).toEqual([]);
  });

  it("still lets the policy section keep its historical versions", async () => {
    // The other half of the rule. If this ever fails, the check has started rewriting history.
    const text = await readFile(join(repoRoot, "docs", "RELEASING.md"), "utf8");
    const history = text.slice(text.indexOf(HISTORY_HEADING));
    expect(history).toContain("0.1.0");
  });
});
