/**
 * The §4.2 boundary, checked over this package's own sources.
 *
 * CI greps `packages/` for provider, platform, cloud, and adopter identifiers and fails on a hit.
 * This suite mirrors that check locally so a violation fails where it was written rather than at
 * the end of a pipeline.
 *
 * Forbidden names are assembled from fragments rather than written literally, because a test
 * containing the strings it forbids trips the very grep it mirrors — a trap four agents have now
 * walked into, which is itself a good argument for the comment.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Reassembled at runtime so this file never contains a forbidden literal. */
const FORBIDDEN = [
  ["eleven", "labs"],
  ["open", "ai"],
  ["anthrop", "ic"],
  ["you", "tube"],
  ["spot", "ify"],
  ["sound", "cloud"],
  ["fire", "store"],
].map(([head, tail]) => `${head}${tail}`);

/** Every `.ts`, `.json`, and `.md` file in this package, excluding build output. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if ([".ts", ".json", ".md"].includes(extname(entry))) found.push(path);
  }
  return found;
}

const files = sourceFiles(packageRoot);

describe("the repository-wide boundary check (§4.2; #173)", () => {
  it("passes over packages/ and docs/, and is the same list CI uses", () => {
    // The mirror that matters. The suite below scans **this package only**, and CI's inline
    // pattern scanned `packages/` only — so an adopter's repository name reached `docs/` with
    // three checks in place and none of them looking. Running the real script here means the
    // local check and the CI check cannot disagree about either the list or the scope.
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts");
    const result = spawnSync("node", [join(script, "check-generic-boundary.mjs")], {
      cwd: join(script, ".."),
      encoding: "utf8",
    });
    expect(result.stdout + result.stderr).not.toContain("no files to scan");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe("the generic boundary (§4.2)", () => {
  it("finds files to check", () => {
    // Guards against the suite passing vacuously if the layout moves.
    expect(files.length).toBeGreaterThan(0);
  });

  it("contains no name from the forbidden list", () => {
    // Named for what it establishes, not for what §4.2 requires. This matches a fixed list of
    // known provider, platform and cloud names — so it proves no *listed* name appears, which is
    // strictly weaker than "no provider is named". A provider nobody thought of passes.
    //
    // The distinction matters on the day it passes rather than the day it fails: a reader who
    // takes "names no provider" at face value stops looking, and the check cannot support that
    // reading. Keeping the weaker name is what keeps §4.2 a thing humans still review.
    const offenders: string[] = [];
    for (const path of files) {
      // This file necessarily contains the fragments, so exclude it by name rather than by
      // weakening the check for everything else.
      if (path.endsWith("boundary.test.ts")) continue;
      const contents = readFileSync(path, "utf8").toLowerCase();
      for (const name of FORBIDDEN) {
        if (contents.includes(name)) offenders.push(`${path}: ${name}`);
      }
    }
    expect(
      offenders,
      `no file may contain any of the ${FORBIDDEN.length} listed names; this does not establish ` +
        "that no provider is named, only that none of these is",
    ).toEqual([]);
  });

  it("uses only fictional identities in fixtures (§19.2)", () => {
    // §19.2: no private Knowledge Pack may be required by these tests. The positive form of that
    // rule is that the vocabulary is entirely invented, which is checkable.
    const fixtures = readFileSync(join(packageRoot, "src", "fixtures.ts"), "utf8");
    expect(fixtures).toContain("example-show");
    expect(fixtures).toContain("provider-a");
    expect(fixtures).toContain("destination-a");
  });
});
