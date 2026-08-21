/**
 * Run every mutant case and assert its own result (ADR-0050's review protocol).
 *
 * ## Why this exists
 *
 * A review request used to paste mutants as shell one-liners for a reviewer to re-run. Two shells
 * produced two invalid measurements in one day:
 *
 * - probing with **uncommitted** edits, when `git diff base...HEAD` reads the committed tree — so
 *   nothing fired and a working check nearly went on the record as broken;
 * - `git reset --hard` deleting the check script, which was itself uncommitted — so later cases
 *   exited non-zero from `MODULE_NOT_FOUND` and read as passes;
 * - `node scripts/$cmd` in zsh, which does not word-split unquoted expansions, so every case
 *   invoked one filename containing a space and every one failed identically;
 * - piping to `head` and reading `head`'s status rather than the command's.
 *
 * None of those was carelessness about the checks. They were shells. So the shell comes out of the
 * path: the cases are data in `mutants.mjs`, and this runs them and compares.
 *
 * ## Three properties that make a result trustworthy
 *
 * **It refuses to run against a dirty worktree.** Every case commits and resets, and a reset over
 * uncommitted work is how the instrument got deleted the first time. Refusing is the fix for that
 * mistake encoded rather than remembered.
 *
 * **It preflights every command's script.** A missing file exits non-zero exactly like a real
 * negative, and `MODULE_NOT_FOUND` read as a finding is how *both* invalid runs happened. If a
 * script named by a case is absent, this exits 2 before running anything.
 *
 * **Every case asserts an output fragment, not only a status.** A status cannot distinguish a
 * finding from a typo. The output can.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

import { cases } from "./mutants.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

// --- Refuse a dirty worktree ---------------------------------------------------------------------
const dirty = git("status", "--porcelain").trim();
if (dirty.length > 0) {
  console.error(
    "run-mutants: the worktree is not clean, and every case commits and resets. Refusing rather " +
      "than risking uncommitted work — deleting an uncommitted instrument with `git reset --hard` " +
      "is how one of these runs became invalid.\n",
  );
  console.error(dirty);
  process.exit(2);
}

// --- Preflight: a missing script must never read as a negative ----------------------------------
const missing = [
  ...new Set(
    cases
      .map(({ command }) => command.find((part) => part.endsWith(".mjs")))
      .filter((path) => path !== undefined),
  ),
].filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error("run-mutants: a case names a script that does not exist:");
  for (const path of missing) console.error(`  ${path}`);
  console.error("\nA missing file exits like a real negative; refusing before anything runs.");
  process.exit(2);
}

if (cases.length === 0) {
  console.error("run-mutants: no cases; refusing to pass vacuously.");
  process.exit(2);
}

const base = git("rev-parse", "HEAD").trim();
const failures = [];

for (const testCase of cases) {
  for (const step of testCase.setup) {
    if (step.append !== undefined) {
      const [path, line] = step.append;
      appendFileSync(path, `\n${line}\n`);
    }
    if (step.replace !== undefined) {
      // Mutating an **existing exported value**, which `append` cannot do. A case that appends a
      // new export cannot be measured through the package boundary at all, because the index
      // re-exports named symbols — the first version of the rebuild guard's own case made that
      // mistake and read as a guard failure.
      const [path, from, to] = step.replace;
      const contents = readFileSync(path, "utf8");
      if (!contents.includes(from)) {
        console.error(`run-mutants: replace target not found in ${path}: ${JSON.stringify(from)}`);
        process.exit(2);
      }
      writeFileSync(path, contents.replace(from, to));
    }
    if (step.version !== undefined) {
      const path = "packages/aldus-core/package.json";
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.version = step.version;
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  if (testCase.setup.length > 0) {
    git("add", "-A");
    git("-c", "user.email=mutants@local", "-c", "user.name=mutants", "commit", "-qm", "mutant");
  }

  // **Rebuild before measuring**, whenever the setup edited a built source.
  //
  // Without this the mutation never reaches the code under test: `@aldus-runtime/core` resolves
  // through package `exports` to `dist`, so a sibling importing it sees the last build. Measured —
  // `src` set to `99.99` and a sibling still resolving `1.11`. A case that edited a built source
  // and measured through another package would report **SURVIVED for a mutation that never took
  // effect**, which is worse than the dirty-worktree and vacuous-diff cases: those refused to
  // answer, and this one would answer wrongly.
  //
  // Derived from the setup paths rather than declared per case, because a flag that must be
  // remembered is the thing this whole file exists to replace. Incremental, so it costs nothing
  // for the cases that touch no source.
  const touchesBuiltSource = testCase.setup.some((step) => {
    const path = step.append?.[0] ?? step.replace?.[0];
    return path !== undefined && /^packages\/[^/]+\/src\//.test(path);
  });
  if (touchesBuiltSource) {
    const build = spawnSync("npm", ["run", "build"], { encoding: "utf8" });
    if (build.status !== 0) {
      git("reset", "-q", "--hard", base);
      console.log(`✗ ${testCase.name}`);
      console.log(`    build failed after setup (exit ${build.status}) — case not measured`);
      failures.push({
        name: testCase.name,
        problems: ["build failed after setup; the case was not measured"],
        output: [],
      });
      continue;
    }
  }

  const [command, ...args] = testCase.command;
  const run = spawnSync(command, args, { encoding: "utf8" });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const status = run.status;

  const problems = [];
  if (status !== testCase.wantExit) problems.push(`exit ${status}, want ${testCase.wantExit}`);
  if (!output.includes(testCase.wantOutput)) {
    problems.push(`output lacks ${JSON.stringify(testCase.wantOutput)}`);
  }
  if (output.includes("MODULE_NOT_FOUND")) {
    problems.push("MODULE_NOT_FOUND — the instrument, not the subject");
  }

  git("reset", "-q", "--hard", base);

  if (problems.length > 0) {
    failures.push({ name: testCase.name, problems, output: output.trim().split("\n").slice(0, 4) });
    console.log(`✗ ${testCase.name}`);
    for (const problem of problems) console.log(`    ${problem}`);
  } else {
    console.log(`✓ ${testCase.name}`);
  }
}

// Restores the **tree** after the loop. The per-case rebuild above is what makes each measurement
// valid; this is what stops the tree being left stale for whatever runs next.
//
// Every case commits a source edit and resets it, which gives the restored files mtimes newer than
// the build they came from. `fresh-build.test.ts` then fails, correctly: a suite loading a stale
// build tests something other than the source, which is the same principle as verifying in the
// environment that will run it. Rebuilding here means running mutants never leaves a tree whose
// next suite run is measuring the wrong thing.
if (cases.some((testCase) => testCase.setup.length > 0)) {
  process.stdout.write("\nrebuilding after source resets… ");
  const build = spawnSync("npm", ["run", "build"], { encoding: "utf8" });
  console.log(build.status === 0 ? "done" : `FAILED (exit ${build.status})`);
  if (build.status !== 0) {
    console.error(build.stdout ?? "");
    console.error(build.stderr ?? "");
    process.exit(2);
  }
}

console.log(`\n${cases.length - failures.length}/${cases.length} mutant cases behaved as stated.`);
if (failures.length > 0) {
  console.log("\nFailing cases, first lines of output:");
  for (const failure of failures) {
    console.log(`  ${failure.name}`);
    for (const line of failure.output) console.log(`      ${line}`);
  }
  process.exit(1);
}
