/**
 * Verify a claim about a change's blast radius instead of asserting it (#173).
 *
 * "docs-only", "test-only", "test-harness-only" — each was stated in this repository and at least
 * one was false: `RecordingReleaseAdapter` is exported from a package index, so a change to it
 * reaches an adopter's test suite the way a contract change reaches their production code. The
 * habit that catches it is checking the **export surface, not the file path**, and this is that
 * habit as a command.
 *
 *   node scripts/check-claim-scope.mjs <base-ref> docs-only
 *   node scripts/check-claim-scope.mjs <base-ref> no-shipped-change
 *
 * `docs-only` — nothing outside `docs/` changed.
 * `no-shipped-change` — nothing `files`-scoped in any published package changed. This is the claim
 * "test-only" and "test-harness-only" were reaching for, stated in terms of what ships rather than
 * where the file lives.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { BASE_REF_NOTE, declineMissingArgument, declineUnknownClaim } from "./declined.mjs";

/** The claims this gate can evaluate. One list, so no message can drift from the branches. */
const CLAIMS = ["docs-only", "no-shipped-change"];
const USAGE = `<base-ref> <${CLAIMS.join("|")}>`;
const EXAMPLE = "origin/main docs-only";
const NOTES = `${BASE_REF_NOTE}\n<claim> is the claim to verify: ${CLAIMS.join(", ")}.`;
const decline = (argument) =>
  declineMissingArgument("check-claim-scope.mjs", argument, USAGE, EXAMPLE, NOTES);

// Every declined case is decided here, before the gate touches the repository, so what a missing
// or unusable argument produces cannot depend on where the script was run. That ordering is the
// property `gate-declined.test.ts` pins: the mutant that survived PR #264's review moved a guard
// below the work, and every test that existed still passed.
const [base, claim] = process.argv.slice(2);
if (base === undefined) decline("<base-ref>");
if (claim === undefined) decline("<claim>");
if (!CLAIMS.includes(claim))
  declineUnknownClaim("check-claim-scope.mjs", claim, USAGE, EXAMPLE, NOTES);

const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
  encoding: "utf8",
})
  .split("\n")
  .filter((line) => line.length > 0);

if (changed.length === 0) {
  console.error("check-claim-scope: the diff is empty; refusing to pass vacuously.");
  process.exit(2);
}

let violations = [];
if (claim === "docs-only") {
  violations = changed.filter((path) => !path.startsWith("docs/"));
} else if (claim === "no-shipped-change") {
  const dirs = execFileSync("node", ["scripts/publish-dirs.mjs"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((absolute) => relative(process.cwd(), absolute));
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    const scoped = (manifest.files ?? []).filter((entry) => entry !== "dist");
    for (const path of changed) {
      if (!path.startsWith(`${dir}/`)) continue;
      const within = path.slice(dir.length + 1);
      if (
        within === "package.json" ||
        scoped.some((e) => within === e || within.startsWith(`${e}/`))
      ) {
        violations.push(path);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`The claim "${claim}" is false. ${violations.length} path(s) contradict it:`);
  for (const path of violations) console.error(`  ${path}`);
  console.error(
    "\nA claim about a boundary should be checked against the export surface rather than the " +
      'file path — see CLAUDE.md, "Check the mechanism, not its description".',
  );
  process.exit(1);
}

console.log(`check-claim-scope: "${claim}" holds across ${changed.length} changed paths.`);
