/**
 * A merge's diff must be a subset of the union of its parents' diffs (#173).
 *
 * A conflict resolution is the one place an unrelated change travels invisibly: the diff a reviewer
 * reads is the merge against one parent, and anything introduced *during* the resolution looks like
 * it came from the other side. This makes the property checkable instead of trusted — it is how a
 * reviewer established by hand that `97f1ae5` smuggled nothing into the #165/#168 resolution.
 *
 * The check is directional-free: every path the merge touches must be a path at least one parent
 * touched. A path in neither is a change that entered with the resolution and nothing reviewed it.
 *
 * It does **not** establish that the resolution chose correctly — only that it did not introduce a
 * file neither side changed. Choosing one caller's shape and dropping the other's argument is a
 * correct-surface, wrong-content failure, and no diff comparison catches it.
 */

import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const merge = process.argv[2];
if (merge === undefined) {
  console.error("usage: check-resolution-surface.mjs <merge-commit>");
  process.exit(2);
}

const parents = git("log", "-1", "--format=%P", merge).trim().split(/\s+/).filter(Boolean);
if (parents.length < 2) {
  console.error(
    `check-resolution-surface: ${merge} is not a merge commit (${parents.length} parent(s)).`,
  );
  process.exit(2);
}

const pathsIn = (from, to) =>
  new Set(
    git("diff", "--name-only", `${from}...${to}`)
      .split("\n")
      .filter((l) => l.length > 0),
  );

const base = git("merge-base", ...parents).trim();
const allowed = new Set();
for (const parent of parents) for (const path of pathsIn(base, parent)) allowed.add(path);

const touched = [...pathsIn(base, merge)];
if (touched.length === 0) {
  console.error("check-resolution-surface: the merge touches nothing; refusing to pass vacuously.");
  process.exit(2);
}

const smuggled = touched.filter((path) => !allowed.has(path));
if (smuggled.length > 0) {
  console.error(
    `This merge changes ${smuggled.length} path(s) neither parent changed, so they entered with ` +
      "the resolution and nothing reviewed them:",
  );
  for (const path of smuggled) console.error(`  ${path}`);
  process.exit(1);
}

console.log(
  `check-resolution-surface: ${touched.length} paths, all within the union of ` +
    `${parents.length} parents' diffs.`,
);
