/**
 * A pull request that changes shipped contents must bump the version (ADR-0050).
 *
 * ## Why this is on the pull request rather than the merge
 *
 * `release-intent.mjs` answers "does this merge publish?" and is deliberately silent when the
 * version is unchanged, because firing on every merge would fail every docs-only merge and leave
 * `main` red between releases — a check that fires on the ordinary case is a check people route
 * around.
 *
 * That leaves one residual, and it is the case that already produced an error: a change to a
 * published package lands in `main`, nothing ships because nothing was bumped, and a log line in a
 * green run tells nobody. An adopter then finds an arm that was ruled available and never published.
 *
 * So the check belongs on the **reviewed event**. It fires before the merge exists, so `main` is
 * never red for it; it fails the PR, so it is not silent; and it fails where fixing it is free —
 * one line in a diff already open. The bump is part of what makes a merge publishable, so it
 * belongs in the review that makes the merge.
 *
 * ## Why `files`-scoped rather than directory-scoped
 *
 * Comparing whole package directories would fire on a test-only or docs-only change to a published
 * package, which is the over-firing that made a merge-time version of this check unworkable. Only
 * paths npm would put in the tarball count — the `files` array, minus `dist`, which is built rather
 * than committed. In practice: `src/`, `schema/`, `LICENSE`, `NOTICE`, `package.json`.
 *
 * A change under `test/` ships nothing and does not fire. That is the point.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const base = process.argv[2];
if (base === undefined) {
  console.error("usage: check-version-bump.mjs <base-ref>");
  process.exit(2);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const dirs = execFileSync("node", ["scripts/publish-dirs.mjs"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((line) => line.length > 0)
  .map((absolute) => relative(process.cwd(), absolute));

if (dirs.length === 0) {
  console.error("check-version-bump: no publishable packages found; refusing to pass vacuously.");
  process.exit(2);
}

const changed = git("diff", "--name-only", `${base}...HEAD`)
  .split("\n")
  .filter((line) => line.length > 0);

/**
 * Whether a path inside a package would end up in its tarball.
 *
 * `dist` is excluded deliberately — generated, never committed, so a diff can never touch it, and
 * listing it would invite a reader to think it could.
 */
function shipsFrom(dir, path) {
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  const scoped = (manifest.files ?? []).filter((entry) => entry !== "dist");
  const withinPackage = path.slice(dir.length + 1);
  if (withinPackage === "package.json") return true;
  return scoped.some((entry) => withinPackage === entry || withinPackage.startsWith(`${entry}/`));
}

const offenders = [];
for (const dir of dirs) {
  const touched = changed.filter((path) => path.startsWith(`${dir}/`) && shipsFrom(dir, path));
  if (touched.length === 0) continue;

  let before;
  try {
    before = JSON.parse(git("show", `${base}:${dir}/package.json`)).version;
  } catch {
    before = undefined;
  }
  const now = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version;

  // A package absent at the base is new, and a new package has nothing to bump from.
  if (before !== undefined && before === now) offenders.push({ dir, version: now, touched });
}

if (offenders.length > 0) {
  console.error(
    "This pull request changes what would be published and does not bump the version (ADR-0050).\n",
  );
  for (const { dir, version, touched } of offenders) {
    console.error(`  ${dir} — still ${version}`);
    for (const path of touched.slice(0, 8)) console.error(`      ${path}`);
    if (touched.length > 8) console.error(`      … and ${touched.length - 8} more`);
  }
  console.error(
    "\nThe `next` line publishes on merge, so a merge that changes shipped contents without a " +
      "bump ships nothing and says nothing. Bump the version in this PR — lockstep across every " +
      "package including the root — or move the change out of the published surface.\n" +
      "Only `files`-scoped paths count: a change under `test/` does not require a bump.",
  );
  process.exit(1);
}

console.log(
  `check-version-bump: ${changed.length} changed paths, none alter shipped contents without a bump.`,
);
