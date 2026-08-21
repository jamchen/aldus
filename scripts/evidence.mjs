/**
 * Emit the evidence block for a review request, measured rather than transcribed.
 *
 *   node scripts/evidence.mjs [--base origin/main] [--suites]
 *
 * ## Why this exists, from a controlled experiment nobody designed
 *
 * PR #176 carried two claims. The mutant table came from `run-mutants.mjs` and was correct, 14/14.
 * The `docs-only` claim was hand-transcribed and was false twice — the path was wrong, and the run
 * that "confirmed" it had refused as vacuous. Same author, same PR, same hour: the machine-produced
 * claim was right and the human-copied one was wrong. The transcription step is the defect, so this
 * removes it.
 *
 * ## Three states per check, not two
 *
 * The failure that has cost the most is **a non-answer read as an answer** — `MODULE_NOT_FOUND` as
 * a meaningful exit code, a dirty-worktree refusal read as a preflight pass, and
 * `check-claim-scope` refusing an empty diff read as `docs-only` holding. In none of those was the
 * object or the venue wrong: the instrument declined to answer and the answer was recorded anyway.
 *
 * Better wording does not fix it. The refusal it hid behind printed `refusing to pass vacuously` on
 * stderr with exit 2, against `holds across N changed paths` on stdout with exit 0. The tool was
 * unmistakable; the reading was not.
 *
 * So a check here is `PASS`, `FAIL`, or **`DECLINED`**, and `DECLINED` is never folded into either.
 * A block containing one is not a block with a failing check — it is a block with a question that
 * was not answered, which is a different thing to hand a reviewer.
 *
 * ## What it will not do
 *
 * `claims:` and `does not:` stay human. What a claim rests on and what a change fails to establish
 * are judgements, and a tool that emitted them would be inventing the part worth reading. It prints
 * them as marked placeholders so that filling them in cannot be confused with a measured result.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const base = (() => {
  const index = args.indexOf("--base");
  return index === -1 ? "origin/main" : args[index + 1];
})();
const withSuites = args.includes("--suites");
// `--no-mutants` exists so a mutant case can cover this emitter without the two invoking each
// other forever. Adding an evidence case to `mutants.mjs` while this ran `run-mutants.mjs`
// unconditionally was mutual recursion, and it presented as a ten-minute hang rather than as an
// error — a non-answer again, in the shape of no answer at all.
const withMutants = !args.includes("--no-mutants");

// --- --check <file>: validate a *filled* block ---------------------------------------------------
//
// The `verified at:` field exists to make an omission visible. If nothing checks that it was
// filled, the omission is visible only to a reader already looking — which is the population that
// did not need the field. An unvalidated required field restores the invisibility it was added to
// remove and becomes decoration, which is worse than absent because it looks like coverage.
//
// Two behaviours, and the split is deliberate.
//
// **Refuses** structural absence: a residual `<FILL`, a claim with no `verified at:`, a claim with
// no `invalidated by:`. Mechanical and unambiguous.
//
// **Surfaces without refusing** the substantive risk: claims whose locus is a report. A report can
// be a legitimate locus — "NOT independently checked, because it is a counterfactual and cannot be"
// is stronger than any file:line for a claim about the past — so refusing would be wrong. A
// reviewer is told how many rest there without hunting for them.
//
// **What it does not do**, stated here because a validator implying otherwise would be the first
// failure category inside the tool built for the fifth: it catches a missing or placeholder field,
// never a false one. `verified at: yes` passes. It checks that the question was answered, not that
// the answer is true.
const checkIndex = args.indexOf("--check");
if (checkIndex !== -1) {
  const file = args[checkIndex + 1];
  if (file === undefined) {
    console.error("usage: evidence.mjs --check <file>");
    process.exit(2);
  }
  const text = readFileSync(file, "utf8");
  const problems = [];
  const notes = [];

  if (text.includes("<FILL")) {
    const count = text.split("<FILL").length - 1;
    problems.push(`${count} placeholder(s) still present: the block was emitted and not filled in`);
  }

  const claimsStart = text.indexOf("claims:");
  if (claimsStart === -1) {
    problems.push("no `claims:` section — a block with no claims establishes nothing");
  } else {
    const doesNot = text.indexOf("does not:", claimsStart);
    const section = text.slice(claimsStart, doesNot === -1 ? text.length : doesNot);
    // Split on `claim:` starts, dropping the `claims:` header itself.
    const blocks = section
      .split(/^\s*claim:/m)
      .slice(1)
      .map((block) => block.trim());
    if (blocks.length === 0) {
      problems.push("`claims:` contains no `claim:` entry");
    }
    blocks.forEach((block, index) => {
      const label = (block.split("\n")[0] ?? "").trim().slice(0, 56) || `#${index + 1}`;
      if (!/verified at:/.test(block)) {
        problems.push(
          `claim "${label}" has no \`verified at:\` — the omission this field exists for`,
        );
      }
      if (!/invalidated by:/.test(block)) {
        problems.push(`claim "${label}" has no \`invalidated by:\``);
      }
      const locus = block.match(/verified at:\s*(.*)/);
      if (locus?.[1]?.trim().startsWith("report:") === true) {
        notes.push(label);
      }
    });
  }

  if (problems.length > 0) {
    console.error(`evidence --check ${file}: ${problems.length} structural problem(s):\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      "\nThis checks that each question was answered, never that an answer is true — " +
        "`verified at: yes` would pass.",
    );
    process.exit(1);
  }

  console.log(`evidence --check ${file}: every claim states a locus and an invalidator.`);
  if (notes.length > 0) {
    console.log(
      `\n${notes.length} claim(s) rest on a report rather than on code — legitimate, and worth a ` +
        "reviewer's attention:",
    );
    for (const label of notes) console.log(`  ${label}`);
  }
  console.log(
    "\nNot checked: whether any stated locus is real. This catches a missing or placeholder " +
      "field, never a false one.",
  );
  process.exit(0);
}

const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();

/**
 * Run one check and classify it in three states.
 *
 * `declinedOn` lists exit codes the check documents as "I did not answer". Everything else is a
 * real verdict. A check that exits 2 because it refused is not a check that failed.
 */
function check(label, command, { declinedOn = [2], kind = "gate" } = {}) {
  const [bin, ...rest] = command;
  const run = spawnSync(bin, rest, { encoding: "utf8" });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  const first = output.split("\n")[0] ?? "";
  // A **query** reports TRUE/FALSE; a **gate** reports PASS/FAIL. A false claim is an answer, not a
  // failing check, and listing it as FAIL is the same category error one level up — a reviewer
  // scanning for failures would stop at a line that is simply the answer to a question.
  const declined = declinedOn.includes(run.status ?? -1);
  const state = declined
    ? "DECLINED"
    : kind === "query"
      ? run.status === 0
        ? "TRUE"
        : "FALSE"
      : run.status === 0
        ? "PASS"
        : "FAIL";
  return { label, command: command.join(" "), exit: run.status, state, first, output, kind };
}

const checks = [
  check("generic-boundary", ["node", "scripts/check-generic-boundary.mjs"]),
  check("build-topology", ["node", "scripts/check-build-topology.mjs"]),
  check(
    "claim: no-shipped-change",
    ["node", "scripts/check-claim-scope.mjs", base, "no-shipped-change"],
    { kind: "query" },
  ),
  check("claim: docs-only", ["node", "scripts/check-claim-scope.mjs", base, "docs-only"], {
    kind: "query",
  }),
  check("version-bump", ["node", "scripts/check-version-bump.mjs", base]),
  check("release-intent", ["node", "scripts/release-intent.mjs", base]),
  ...(withMutants ? [check("mutants", ["node", "scripts/run-mutants.mjs"])] : []),
];

const suites = [];
if (withSuites) {
  for (const pkg of ["aldus-services", "aldus-stage-runner", "aldus-e2e"]) {
    const run = spawnSync("npx", ["vitest", "run", "--root", `packages/${pkg}`], {
      encoding: "utf8",
    });
    // stdout *and* stderr: vitest writes the summary to stderr, and the first version of this read
    // stdout only and printed `e2e ?`. A `?` in an evidence block is a non-answer printed as data —
    // the exact failure this emitter exists to prevent, in its own output. An unparseable count is
    // now `DECLINED` and makes the whole block exit non-zero.
    const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const match = combined.match(/Tests\s+(?:\d+ failed \| )?(\d+) passed/);
    const failed = /Tests\s+\d+ failed/.test(combined);
    suites.push({
      name: pkg.replace("aldus-", ""),
      count: match?.[1],
      failed,
      state: match === undefined ? "DECLINED" : failed ? "FAIL" : "PASS",
    });
  }
}

const mutants = checks.find((entry) => entry.label === "mutants");
const mutantSummary = withMutants
  ? (mutants?.output.split("\n").find((line) => line.includes("behaved as stated")) ??
    `(${mutants?.state})`)
  : "(not run — --no-mutants)";

const width = Math.max(...checks.map((entry) => entry.label.length));
const lines = [
  "```",
  `head:      ${head}${dirty.length > 0 ? "  ⚠ WORKTREE DIRTY — this block describes uncommitted state" : ""}`,
  `base:      ${base}`,
];
if (withSuites) {
  lines.push(
    `suites:    ${suites
      .map((suite) => `${suite.name} ${suite.count ?? suite.state}${suite.failed ? " FAILED" : ""}`)
      .join(" · ")}  (measured)`,
  );
}
lines.push("checks:");
for (const entry of checks) {
  lines.push(`  ${entry.label.padEnd(width)}  exit=${entry.exit}  ${entry.state}`);
  if (entry.state === "DECLINED" || entry.state === "FAIL") {
    lines.push(`  ${" ".repeat(width)}    ${entry.first}`);
  }
}
lines.push(`mutants:   ${mutantSummary}`);
lines.push(`           node scripts/run-mutants.mjs`);
// `claims:` requires **where each claim was verified**, not only what would invalidate it.
//
// The fifth failure mode is a premise inherited from a report and never checked in the code, and
// what makes it survive is that the omission is invisible — nothing in a block distinguishes "I
// opened the file" from "the report said so". A required field is the move for invisibility, the
// way the vacuous-diff refusal is: it cannot tell a wrong claim from a right one, and it makes "I
// measured nothing" impossible to record as "I measured and it was fine".
//
// Three honest answers and no fourth. A `file:line` requires opening the code, and opening the code
// *is* the remedy. `report:` makes the inheritance visible, which is all three of that day's
// instances caught at a glance. Blank is a hole rather than an absence.
lines.push("claims:    <FILL — one block per claim, and leave nothing implicit>");
lines.push("             claim:          <what is being claimed>");
lines.push("             verified at:    <file:line — or `report: <who said it>`, adding why the");
lines.push(
  "                              hole is irreducible if it is — or leave it visibly empty.",
);
lines.push("                              If this would be a command, the claim belongs in");
lines.push("                              checks: above, not here.>");
lines.push("             invalidated by: <what would falsify it>");
lines.push("does not:  <FILL: what this change does NOT establish>");
lines.push("```");

console.log(lines.join("\n"));

const declined = [
  ...checks.filter((entry) => entry.state === "DECLINED"),
  ...suites
    .filter((suite) => suite.state !== "PASS")
    .map((suite) => ({ label: `suite ${suite.name}`, first: `state ${suite.state}` })),
];
if (declined.length > 0) {
  console.error(
    `\n${declined.length} check(s) DECLINED to answer. That is not a pass and not a failure — ` +
      "resolve it before pasting this block:",
  );
  for (const entry of declined) console.error(`  ${entry.label}: ${entry.first}`);
  process.exit(2);
}
