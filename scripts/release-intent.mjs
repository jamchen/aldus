/**
 * Whether this merge intends to publish, and whether it can (ADR-0050).
 *
 * Unattended publishing on merge needs one question answered before anything is written: **did this
 * merge bump the version?** Three states, and conflating any two of them breaks something:
 *
 * - **unchanged** — the merge did not intend to ship. Docs, tests, a refactor. Publishes nothing
 *   and succeeds. Treating this as a failure would make `main` red between releases, which is a
 *   broken signal rather than a loud one.
 * - **bumped, and not on the registry** — publish it.
 * - **bumped, and already on the registry** — refuse, loudly. Two PRs both bumping to the same
 *   number is not hypothetical: six were open at once on the day this was written, and the second
 *   to merge carries a version the first already shipped.
 *
 * The refusal is checked for the **whole set**. `release.yml`'s per-package skip exists because a
 * twelve-package publish set has twelve ways to fail halfway and a retry must resume rather than
 * die on its own earlier success — so "every package already present" means nothing was bumped and
 * refuses, while a partially-published set still resumes. Same fact, two readings, and the
 * distinction is whether *all* of the set is there.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** `git show <ref>:<path>`, or undefined when the path did not exist at that ref. */
function fileAtRef(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
  } catch {
    return undefined;
  }
}

function versionAt(ref) {
  const contents = fileAtRef(ref, "packages/aldus-core/package.json");
  if (contents === undefined) return undefined;
  return JSON.parse(contents).version;
}

/** Every publishable directory, from the same source `release.yml` uses. */
function publishDirs() {
  return execFileSync("node", ["scripts/publish-dirs.mjs"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function onRegistry(name, version) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const before = process.argv[2];
const current = JSON.parse(readFileSync("packages/aldus-core/package.json", "utf8")).version;
const previous = before === undefined ? undefined : versionAt(before);

if (previous !== undefined && previous === current) {
  console.log(`release-intent: version unchanged at ${current}; this merge publishes nothing.`);
  console.log("publish=false");
  process.exit(0);
}

// The previous version could not be read, so **intent is unknown** — and unknown intent must not be
// inferred from the registry. Falling through to the whole-set check treats "I cannot see the
// history" as "this merge bumped to a version already published", which is a different claim and a
// false one. It failed on the first run after the trigger moved: `actions/checkout` is shallow by
// default, so the previous `main` commit was not in the local history at all, and a merge that
// changed nothing shippable reported an attempted republish and turned `main` red.
//
// Not publishing is the safe answer here, and it costs nothing real: the PR-side
// `check-version-bump.mjs` already refuses a shipped change that did not bump, so a bump this
// cannot see is a bump that was reviewed.
if (previous === undefined) {
  console.log(
    `release-intent: cannot read the previous version at ${before ?? "(no ref given)"}, so ` +
      "whether this merge bumped is unknown; publishing nothing rather than inferring intent " +
      "from the registry.",
  );
  console.log("publish=false");
  process.exit(0);
}

const dirs = publishDirs();
if (dirs.length === 0) {
  console.error("release-intent: no publishable packages found; refusing to pass vacuously.");
  process.exit(2);
}

const present = [];
const missing = [];
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  (onRegistry(manifest.name, manifest.version) ? present : missing).push(
    `${manifest.name}@${manifest.version}`,
  );
}

if (missing.length === 0) {
  console.error(
    `release-intent: every package at ${current} is already on the registry, so this merge is ` +
      "attempting a republish. Bump the version in a reviewed PR (ADR-0050).",
  );
  for (const entry of present) console.error(`  already published: ${entry}`);
  process.exit(1);
}

console.log(
  `release-intent: ${current} — ${missing.length} of ${dirs.length} packages to publish` +
    (present.length > 0 ? `, ${present.length} already present (resuming)` : ""),
);
console.log("publish=true");
