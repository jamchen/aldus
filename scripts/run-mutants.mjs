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

console.log(`\n${cases.length - failures.length}/${cases.length} mutant cases behaved as stated.`);
if (failures.length > 0) {
  console.log("\nFailing cases, first lines of output:");
  for (const failure of failures) {
    console.log(`  ${failure.name}`);
    for (const line of failure.output) console.log(`      ${line}`);
  }
  process.exit(1);
}
