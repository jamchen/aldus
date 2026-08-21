/**
 * Assert the fact `run-mutants.mjs`'s rebuild predicate silently depends on.
 *
 * That predicate rebuilds when a case's setup edits a package's `src` directory, and it is
 * **exact** — but only because `src` to `dist` is the sole build-mediated path in this repository.
 * Every publishable package compiles from `src` only, with `rootDir: src` and `outDir: dist`, and
 * the two packages exporting something else — `aldus-core`'s JSON schemas and `aldus-testkit`'s
 * fixtures — serve those files **directly**, so no build stands between the source and the
 * consumer and no rebuild is needed.
 *
 * Nothing checked that. If a package later served a generated file from `dist` that did not live
 * under `src`, the predicate would stop matching the property it stands for, and the failure would
 * be the exact one the rebuild guard exists to catch: a mutation that never reaches the code under
 * test, reported as SURVIVED.
 *
 * A predicate that is correct because of an unchecked fact about the world is the shape this
 * repository has corrected repeatedly. This is the fact, checked.
 *
 * Note for whoever edits this header: a glob containing a star followed by a slash closes a block
 * comment. Writing the path literally here is what broke this file the first time, and the parse
 * error pointed at the *next* line rather than the offending one.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const dirs = execFileSync("node", ["scripts/publish-dirs.mjs"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((line) => line.length > 0)
  .map((absolute) => relative(process.cwd(), absolute));

if (dirs.length === 0) {
  console.error("check-build-topology: no publishable packages found; refusing to pass vacuously.");
  process.exit(2);
}

/** Strip line comments so a tsconfig with them still parses. */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

const problems = [];
for (const dir of dirs) {
  let tsconfig;
  try {
    tsconfig = readJson(`${dir}/tsconfig.json`);
  } catch {
    problems.push(`${dir}: no readable tsconfig.json, so its build inputs are unknown`);
    continue;
  }

  const include = tsconfig.include ?? [];
  const rootDir = tsconfig.compilerOptions?.rootDir;
  const outDir = tsconfig.compilerOptions?.outDir;

  const compilesOnlySrc = include.every((entry) => entry.startsWith("src/"));
  if (!compilesOnlySrc || include.length === 0) {
    problems.push(
      `${dir}: compiles ${JSON.stringify(include)}, not only src/ — the rebuild predicate in ` +
        "run-mutants.mjs would not match a mutation to the other input",
    );
  }
  if (rootDir !== "src") {
    problems.push(`${dir}: rootDir is ${JSON.stringify(rootDir)}, expected "src"`);
  }
  if (outDir !== "dist") {
    problems.push(`${dir}: outDir is ${JSON.stringify(outDir)}, expected "dist"`);
  }
}

if (problems.length > 0) {
  console.error(
    "The build topology no longer matches what run-mutants.mjs's rebuild predicate assumes:\n",
  );
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nEither restore the topology, or widen the predicate — `touchesBuiltSource` in " +
      "scripts/run-mutants.mjs. Leaving both is how a mutation stops reaching the code under test " +
      "while still being reported as measured.",
  );
  process.exit(1);
}

console.log(
  `check-build-topology: ${dirs.length} packages, all compiling src/ -> dist/ as the rebuild ` +
    "predicate assumes.",
);
