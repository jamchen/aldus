#!/usr/bin/env node
/**
 * Record and assert dist-tags around a publish (ADR-0023 decision 4).
 *
 * The 0.1.0 bootstrap published every package with `--tag next` and still ended with `latest`
 * pointing at it, because npm assigns `latest` on a package's first publish regardless of the
 * flag. Nothing in the pipeline noticed; verification afterwards did. This makes an unexpected
 * tag movement fail the job that caused it.
 *
 *   node scripts/dist-tags.mjs snapshot <file>          capture current tags
 *   node scripts/dist-tags.mjs assert <before> [--allow-latest-move]
 *
 * `assert` fails when `latest` differs from the snapshot unless the move was declared. A first
 * publish legitimately creates `latest`, so that case is reported and requires the flag too —
 * an intended exception should be stated, not inferred.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { publishSet } from "./publish-set.mjs";

/** Current dist-tags for one package, or `null` when it does not exist yet. */
function tagsOf(name) {
  try {
    const out = execFileSync("npm", ["view", name, "dist-tags", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out);
  } catch {
    return null; // not published yet
  }
}

function snapshot() {
  return Object.fromEntries(publishSet().map((p) => [p.name, tagsOf(p.name)]));
}

const [mode, file, ...rest] = process.argv.slice(2);

if (mode === "snapshot") {
  const state = snapshot();
  writeFileSync(file, JSON.stringify(state, null, 2));
  for (const [name, tags] of Object.entries(state)) {
    console.log(`  ${name}: ${tags === null ? "(not published)" : JSON.stringify(tags)}`);
  }
  process.exit(0);
}

if (mode === "assert") {
  const allowLatestMove = rest.includes("--allow-latest-move");
  const before = JSON.parse(readFileSync(file, "utf8"));
  const after = snapshot();
  const problems = [];

  for (const [name, afterTags] of Object.entries(after)) {
    const beforeTags = before[name];
    const was = beforeTags?.latest ?? null;
    const now = afterTags?.latest ?? null;

    if (was === now) continue;
    const description =
      was === null
        ? `latest was created pointing at ${now} (first publish of this package)`
        : `latest moved ${was} -> ${now}`;
    if (allowLatestMove) console.log(`  ${name}: ${description} (declared)`);
    else problems.push(`${name}: ${description}`);
  }

  console.log("\nAfter publish:");
  for (const [name, tags] of Object.entries(after)) {
    console.log(`  ${name}: ${JSON.stringify(tags)}`);
  }

  if (problems.length > 0) {
    console.error("\nlatest moved without --allow-latest-move:");
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "\nA release to `next` must not change the default install. If this was intended,\n" +
        "re-run with --allow-latest-move and record why (ADR-0023).",
    );
    process.exit(1);
  }
  console.log("\nlatest unchanged for every package.");
  process.exit(0);
}

console.error("usage: dist-tags.mjs snapshot <file> | assert <file> [--allow-latest-move]");
process.exit(2);
