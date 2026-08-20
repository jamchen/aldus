#!/usr/bin/env node
/**
 * Move `latest` to a published version, across every public package at once (ADR-0023).
 *
 *   node scripts/promote-latest.mjs 0.2.0-next.19
 *
 * **Must be run from a real terminal.** npm requires a one-time password for every
 * publish-class operation, and `dist-tag add` is one — so with no TTY it fails on the first
 * package with `EOTP` and nothing moves. That is the safe failure, but it is a confusing one to
 * meet at the end of a release, so it is stated here and detected below.
 *
 * ## Why the verification retries
 *
 * The first version of this checked each tag immediately after writing it, and reported
 * `tts-ledger` as a partial promotion when the write had in fact succeeded: `npm view` reads a
 * cached path that lags the write by a few seconds. A verification that cries partial-failure on
 * a healthy release is worse than none — the next person learns to re-run it until it agrees,
 * which is the same as not having it. So reads retry, and only a value that stays wrong fails.
 *
 * ## Why all-or-nothing matters
 *
 * Internal dependencies are exact pins. A `latest` where `cli` is one version and `core` another
 * is not a degraded install, it is a broken one — `cli@0.2.0` requires `core@0.2.0` exactly and
 * would resolve `core@0.1.0`. A partial promotion is worse than no promotion, so this reports
 * the split loudly and tells the operator to finish rather than stop.
 */

import { execFileSync } from "node:child_process";

import { publishSet } from "./publish-set.mjs";

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: node scripts/promote-latest.mjs <version>");
  process.exit(2);
}

if (!process.stdin.isTTY) {
  console.error(
    "This must run in a terminal. npm needs a one-time password for each `dist-tag add`, and\n" +
      "with no TTY it cannot prompt — it would fail on the first package. Nothing has changed.",
  );
  process.exit(2);
}

const packages = publishSet().map((entry) => entry.name);

/** Read a dist-tag, retrying past the registry's read-after-write lag. */
function latestOf(name, { attempts = 6, delayMs = 2000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const out = execFileSync("npm", ["view", name, "dist-tags.latest"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out === version || attempt === attempts - 1) return out;
    } catch {
      if (attempt === attempts - 1) return "";
    }
    execFileSync("sleep", [String(delayMs / 1000)]);
  }
  return "";
}

console.log(`Promoting ${version} to latest across ${packages.length} packages.`);
console.log("npm will ask you to authenticate once per package. That is expected.\n");

const written = [];
for (const name of packages) {
  process.stdout.write(`  ${name}\n`);
  try {
    execFileSync("npm", ["dist-tag", "add", `${name}@${version}`, "latest"], { stdio: "inherit" });
    written.push(name);
  } catch {
    // Reported below with everything else. Stopping here would leave the operator holding a split
    // `latest` and no list of what still needs moving, which is the state hardest to recover from.
    console.error(`  FAILED ${name}`);
  }
}

console.log("\nVerifying against the registry, retrying past read-after-write lag:");
const stale = [];
for (const name of packages) {
  const actual = latestOf(name);
  if (actual === version) console.log(`  ok ${name}: ${actual}`);
  else {
    console.log(`  MISMATCH ${name}: latest=${actual || "unreadable"}`);
    stale.push(name);
  }
}

if (stale.length > 0) {
  console.error(
    `\nPARTIAL PROMOTION — \`latest\` is split across versions and installs from it are broken.\n` +
      `Finish rather than stop; re-running is safe and idempotent:\n\n` +
      stale.map((name) => `  npm dist-tag add ${name}@${version} latest`).join("\n"),
  );
  process.exit(1);
}
console.log(`\nAll ${packages.length} packages at ${version}.`);
