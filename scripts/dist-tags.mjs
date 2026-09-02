#!/usr/bin/env node
/**
 * Record and assert dist-tags around a publish (ADR-0023 decision 4).
 *
 * The 0.1.0 bootstrap published every package with `--tag next` and still ended with `latest`
 * pointing at it, because npm assigns `latest` on a package's first publish regardless of the
 * flag. Nothing in the pipeline noticed; verification afterwards did. This makes an unexpected
 * tag movement fail the job that caused it.
 *
 *   node scripts/dist-tags.mjs snapshot <file>
 *   node scripts/dist-tags.mjs assert <before> [--allow-latest-move] [--after-publish]
 *                                              [--deadline-ms N] [--convergence-ms N] [--interval-ms N]
 *
 * `assert` holds **two** invariants for every package in the publish set, not one:
 *
 * - `latest` is exactly the value recorded before the publish, unless the move was declared;
 * - `next` is exactly the version this tree intended to publish for that package.
 *
 * The second is new. Release run 33470723600 published all twelve packages as `0.2.0-next.53` and
 * this step went green while printing `next: 0.2.0-next.52` for two of them — because `next` was
 * printed and never compared, and because the `latest` comparison it did make was reading
 * `undefined` on both sides under CI's npm. `dist-tags-check.mjs` documents both, measured.
 *
 * `assert` has **three** exit codes, and the third is the one added by #266:
 *
 * - 0 — both invariants hold on every package;
 * - 1 — something is wrong: `latest` moved, `next` is a version this publish neither intended nor
 *   recorded beforehand, a reply is malformed, or a package stayed absent or unreadable past
 *   `--deadline-ms`;
 * - 2 — `DECLINED`: after `--convergence-ms`, the only packages not passing still serve **exactly**
 *   the `next` recorded before the publish, with `latest` unmoved. Twice in one day that was the
 *   registry's read side taking about five minutes to catch up on one package, and it was reported
 *   with the same exit code and nearly the same line as a partial publish. The two cannot be told
 *   apart from here, so this says so — neither a pass nor a failure — and names the command that
 *   settles it later.
 *
 * Exit 2 is also what an invocation this script cannot act on gets — a flag that is not a number,
 * a snapshot another schema wrote, no mode at all — and every one of those goes through
 * `declined.mjs` too, so exit 2 has **one** spelling: `DECLINED:` on the first line and the shared
 * legend on the last. The first version kept three bare `dist-tags: …` refusals of its own; the
 * workflow keys its "not yet converged" summary on the exit code, and a refusal exiting 2 with a
 * different first line is how that summary would one day be printed for the wrong reason (PR #270
 * review, finding 4). The workflow now also reads the first line, so both sides hold.
 *
 * `--after-publish` is a statement by the caller, not an inference by the script: `release.yml`
 * passes it because its Publish step precedes this one under `set -e`, so the DECLINED text may
 * then say the publish reported success. Run from a laptop without the flag, the same text says
 * "if this ran after a publish step that succeeded" — the script has no evidence either way and
 * does not pretend to (finding 3).
 *
 * The rule and its reader live in `dist-tags-check.mjs` so they can be driven by a test with a
 * fake registry. This file is argv, files and exit codes.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { declineInvocation, declineMissingArgument, declineUndecided } from "./declined.mjs";
import { publishSet } from "./publish-set.mjs";
import {
  DEFAULT_CONVERGENCE_MS,
  DEFAULT_DEADLINE_MS,
  DEFAULT_INTERVAL_MS,
  SNAPSHOT_SCHEMA,
  assertDistTags,
  npmReader,
} from "./dist-tags-check.mjs";

/** One real `npm view`, as `classifyRun` expects it. */
const run = (args) => spawnSync("npm", args, { encoding: "utf8" });
const read = npmReader(run);

/** The packages and the versions this tree intends to publish, read from the manifests now. */
function expectedFromManifests() {
  return publishSet().map((pkg) => ({ name: pkg.name, version: pkg.manifest.version }));
}

const SCRIPT = "dist-tags.mjs";
const USAGE =
  "snapshot <file> | assert <before> [--allow-latest-move] [--after-publish] " +
  "[--deadline-ms N] [--convergence-ms N] [--interval-ms N]";
const EXAMPLE = 'assert "$RUNNER_TEMP/dist-tags-before.json" --after-publish';
const NOTES = [
  "`snapshot <file>` records every package's `latest` and `next` before the publish.",
  "`assert <before>` re-reads them afterwards and holds both invariants against that file.",
  "`--after-publish` states that a publish step succeeded before this ran; `release.yml` passes it.",
  "`--deadline-ms` bounds an absent or unreadable package (fails closed); `--convergence-ms`",
  "bounds a package still serving the pre-publish `next` (declines), and must not be shorter.",
].join("\n");

/** Every invocation this script cannot act on exits 2 through here, so exit 2 has one spelling. */
function refuse(headline) {
  declineInvocation(SCRIPT, headline, USAGE, EXAMPLE, NOTES);
}

/** A numeric flag, or its default. Declines a value that is not a positive number. */
function numberFlag(argv, flag, fallback) {
  const at = argv.indexOf(flag);
  if (at === -1) return fallback;
  const value = Number(argv[at + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    refuse(
      `${SCRIPT} was given ${flag} ${String(argv[at + 1])}, which is not a positive number, so no gate ran.`,
    );
  }
  return value;
}

/** The snapshot `assert` compares against, or a declined invocation naming what is wrong with it. */
function readSnapshot(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    refuse(
      `${SCRIPT} could not read ${path} as a snapshot (${error instanceof Error ? error.message : String(error)}), so no gate ran.`,
    );
  }
  if (raw?.schema !== SNAPSHOT_SCHEMA || raw.packages === undefined) {
    // A file written by another version records different fields, and reading it as this one is a
    // comparison against values that are not there.
    refuse(
      `${SCRIPT} was given ${path}, which is not a schema-${SNAPSHOT_SCHEMA} snapshot, so no gate ran.`,
    );
  }
  return raw;
}

const [mode, file, ...rest] = process.argv.slice(2);

if ((mode === "snapshot" || mode === "assert") && file === undefined) {
  declineMissingArgument(
    SCRIPT,
    mode === "snapshot" ? "<file>" : "<before>",
    USAGE,
    EXAMPLE,
    NOTES,
  );
}

if (mode === "snapshot") {
  // A read that failed is not a package without tags. The old snapshot recorded both as `null`,
  // which made the baseline itself the thing that could not fail: a registry outage before the
  // publish would record "no tags anywhere" and every later comparison would hold.
  const packages = {};
  const failures = [];
  for (const { name } of expectedFromManifests()) {
    const reading = read(name);
    if (reading.kind === "tags") packages[name] = reading.tags;
    else if (reading.kind === "absent") packages[name] = null;
    else failures.push(`${name}: ${reading.kind} — ${reading.detail}`);
  }

  if (failures.length > 0) {
    console.error("dist-tags: could not record a baseline for every package:");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      "\nA baseline with holes cannot detect a tag that moved. Refusing rather than recording\n" +
        "an absence that was really a failure to look.",
    );
    process.exit(1);
  }

  writeFileSync(file, `${JSON.stringify({ schema: SNAPSHOT_SCHEMA, packages }, null, 2)}\n`);
  for (const [name, tags] of Object.entries(packages)) {
    console.log(`  ${name}: ${tags === null ? "(not published)" : JSON.stringify(tags)}`);
  }
  process.exit(0);
}

if (mode === "assert") {
  const allowLatestMove = rest.includes("--allow-latest-move");
  const afterPublish = rest.includes("--after-publish");
  const deadlineMs = numberFlag(rest, "--deadline-ms", DEFAULT_DEADLINE_MS);
  const convergenceMs = numberFlag(rest, "--convergence-ms", DEFAULT_CONVERGENCE_MS);
  const intervalMs = numberFlag(rest, "--interval-ms", DEFAULT_INTERVAL_MS);
  if (convergenceMs < deadlineMs) {
    refuse(
      `${SCRIPT} was given --convergence-ms ${convergenceMs}, shorter than --deadline-ms ${deadlineMs}, so no gate ran.`,
    );
  }

  const raw = readSnapshot(file);
  const expected = expectedFromManifests();
  const result = await assertDistTags({
    expected,
    before: raw.packages,
    read,
    allowLatestMove,
    deadlineMs,
    convergenceMs,
    intervalMs,
  });

  console.log("\nAfter publish:");
  for (const verdict of result.results) {
    const tags =
      verdict.reading.kind === "tags"
        ? JSON.stringify(verdict.reading.tags)
        : `(${verdict.reading.kind})`;
    console.log(`  ${verdict.name}: ${tags}`);
    for (const declared of verdict.declared) console.log(`    ${declared}`);
  }
  console.log(`\nRead in ${result.rounds} round(s) over ${result.elapsedMs}ms.`);

  if (result.verdict === "declined") {
    // Every package that is not passing reads exactly as it did before the publish, and nothing
    // else is wrong. The registry has not served the new document yet, or the package never
    // published; the two look identical from here (#266: five minutes, twice, same package). The
    // one thing that would distinguish them is time, and the bound is up.
    //
    // Whether a publish preceded this run is the caller's to state, not this script's to assume:
    // `release.yml` passes `--after-publish` because its Publish step runs first under `set -e`.
    // Without the flag the same text is conditional, because from a laptop nothing here knows.
    const names = result.lagging;
    const publishEvidence = afterPublish
      ? [
          "The publish step that precedes this assertion reported success for every package (the",
          "caller passed --after-publish; in `release.yml` this step is not reached otherwise). A",
          "registry whose read side has not caught up and a package that never published read",
          "identically at this point, and this check will not pick one.",
        ]
      : [
          "If this ran after a publish step that succeeded, a registry whose read side has not caught",
          "up and a package that never published read identically at this point, and this check will",
          "not pick one. Nothing here establishes that a publish happened at all — this invocation",
          "did not pass --after-publish, so that is not asserted.",
        ];
    declineUndecided(
      `\`next\` has not converged on ${names.length} of ${expected.length} package(s) after ` +
        `${convergenceMs}ms, so the assertion has no result.`,
      [
        "Still serving the pre-publish `next`, with `latest` unmoved and every other package passing:",
        ...names.map((name) => `  ${name}`),
        "",
        ...publishEvidence,
        "",
        "Re-check once the registry has had time to converge (measured at about five minutes):",
        ...names.map((name) => `  npm view ${name} dist-tags`),
        `and expect next=${expected[0]?.version ?? "<version>"}. If it is still the old value an`,
        "hour later, treat it as a partial publish — recovery is owner-reserved (docs/RELEASING.md).",
        `Observed over ${result.rounds} round(s) and ${result.elapsedMs}ms.`,
      ].join("\n"),
    );
  }

  if (!result.ok) {
    console.error("\ndist-tags assertion FAILED:");
    for (const problem of result.problems) console.error(`  ${problem}`);
    // The footer is keyed on why the loop stopped, not on a flag that covers two stops. The first
    // version keyed on `exhausted`, which is true at the deadline *and* at the convergence bound,
    // so a stray snapshot entry alongside a lagging package printed "deadline exhausted with a
    // package still absent" when nothing was absent (PR #270 review, finding 1).
    if (result.stop === "exhausted") {
      console.error(
        `\nThe ${deadlineMs}ms deadline was exhausted with a package still absent or unreadable.\n` +
          "That is not the measured lag shape (a pre-publish `next` still being served), so it\n" +
          "fails closed rather than declining.",
      );
    } else if (result.stop === "structural") {
      console.error(
        `\nThe snapshot records ${result.strays.length} package(s) the publish set does not contain:\n` +
          result.strays.map((name) => `  ${name}`).join("\n") +
          "\nThe two sides describe different releases, so this fails after one read regardless of\n" +
          "what the packages say — a lagging package alongside it is not waited for.",
      );
    } else if (result.stop === "unconverged") {
      // Unreachable while `assertDistTags` declines on this stop; kept so a future change to the
      // verdict rule does not fall through to silence.
      console.error(
        `\nThe ${convergenceMs}ms convergence bound was reached with a package still serving the\n` +
          "pre-publish `next`.",
      );
    }
    console.error(
      "\nA release to `next` must move `next` to the published version on every package and must\n" +
        "not change `latest`. If a latest move was intended, re-run with --allow-latest-move and\n" +
        "record why (ADR-0023).",
    );
    process.exit(1);
  }

  console.log(
    `\nlatest unchanged and next converged to the intended version on all ${expected.length} packages.`,
  );
  process.exit(0);
}

refuse(
  mode === undefined
    ? `${SCRIPT} was invoked with no mode, so no gate ran.`
    : `${SCRIPT} does not know the mode "${mode}", so no gate ran.`,
);
