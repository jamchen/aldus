#!/usr/bin/env node
/**
 * A breaking change to a public signature must carry a `BREAKING` entry in the CHANGELOG.
 *
 * `0.2.0-next.21` shipped seven undocumented signature changes on the paid-spend and
 * agent-execution path — six required fields appearing and one export removed. The notes described
 * one change. The adopter found the rest by compiling: 8 errors across 6 files.
 *
 * What makes that worth a check rather than a habit is who could have caught it. The adopter asked
 * in advance and in writing what the release contained, got no answer in time, and bumped on a
 * summary that described one change. **Three humans in the loop failed to surface it and the
 * compiler was the only mechanism that did** — and a pinned adopter is, by construction, the last
 * party to know and has no way to volunteer the information. The detection has to move to this
 * side of the line.
 *
 * ## What it compares
 *
 * The **built `.d.ts` export surface**, not source files and not paths. Contract §4.3 and this
 * project's own catalogue both say the same thing: a change's blast radius is a question about the
 * export surface, and describing it from file paths is how "test-only" gets said of a symbol
 * exported from a package index.
 *
 * Breaking, for this check:
 *
 * - an exported symbol present on the base and absent on the head — a removal;
 * - a required member appearing on an exported type that did not have it.
 *
 * ## What it deliberately does not do
 *
 * It does **not** decide whether a change is *semantically* breaking. A field whose meaning
 * changed while its type did not is invisible here, and the two most dangerous changes in that
 * release were exactly that shape — `effectKey` namespacing and `unestimatedExecution` defaulting
 * to refuse both compile cleanly and behave wrongly. This check finds what fails to compile, which
 * is the easier half. Stated here because a check implying otherwise would be the first failure
 * category living inside the tool built for it.
 *
 * Usage: node scripts/check-breaking-notes.mjs <base-ref>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseRef = process.argv[2];
if (baseRef === undefined) {
  console.error("usage: check-breaking-notes.mjs <base-ref>");
  process.exit(2);
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();

/** Every exported symbol, and the required members of each exported type, from built `.d.ts`. */
function surfaceOf(root) {
  const surface = new Map();
  const pkgDir = join(root, "packages");
  if (!existsSync(pkgDir)) return surface;
  const dts = sh("bash", [
    "-c",
    `find ${JSON.stringify(pkgDir)} -path '*/dist/*.d.ts' -not -path '*/node_modules/*' | sort`,
  ]);
  for (const file of dts.split("\n").filter(Boolean)) {
    const pkg = file.slice(pkgDir.length + 1).split("/")[0];
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /^export (?:declare )?(?:abstract )?(class|interface|type|function|const|enum) ([A-Za-z_$][\w$]*)/gm,
    )) {
      surface.set(`${pkg}:${match[2]}`, new Set());
    }
    // Required members of exported **interfaces**. Two restrictions, each from a measured false
    // positive on the run that validated this check against the release it was built for:
    //
    // `interface` only, and the brace must open on the declaration line. A one-line
    // `export type BillingStatus = (typeof BILLING_STATUSES)[number];` has no body, and a pattern
    // that skips ahead to the next `{` attributes the *following* declaration's members to it —
    // which reported `BillingStatus.kind`, a member of `CostExpectation`.
    //
    // And Zod-inferred bodies are skipped: optionality there lives in `z.ZodOptional<…>`, not in a
    // `?`, so every optional field on a schema type reads as newly required. `TakeDelivery.costIds`
    // is declared `z.ZodOptional<z.ZodArray<…>>` and was reported as a break.
    for (const block of text.matchAll(
      /^export (?:declare )?interface ([A-Za-z_$][\w$]*)[^{\n]*\{$([\s\S]*?)^\}/gm,
    )) {
      if (/z\.Zod/.test(block[2])) continue;
      const key = `${pkg}:${block[1]}`;
      const members = surface.get(key) ?? new Set();
      for (const member of block[2].matchAll(/^\s{4}(?:readonly )?([A-Za-z_$][\w$]*)(\??):/gm)) {
        if (member[2] !== "?") members.add(member[1]);
      }
      surface.set(key, members);
    }
  }
  return surface;
}

const repoRoot = sh("git", ["rev-parse", "--show-toplevel"]);
const head = surfaceOf(repoRoot);
if (head.size === 0) {
  console.error("DECLINED: no built .d.ts found at HEAD — run `npm run build` first.");
  console.error("A missing build is not the same answer as a clean surface.");
  process.exit(2);
}

// The base is built in a throwaway worktree, because the surface has to come from the base's own
// compiler output. Reading the base's *source* would answer a different question.
const work = mkdtempSync(join(tmpdir(), "aldus-breaking-"));
let base;
try {
  sh("git", ["worktree", "add", "--detach", work, baseRef]);
  const install = spawnSync("npm", ["ci", "--ignore-scripts"], { cwd: work, encoding: "utf8" });
  const built = spawnSync("npx", ["tsc", "-b"], { cwd: work, encoding: "utf8" });
  base = surfaceOf(work);
  if (base.size === 0) {
    console.error(`DECLINED: could not build the base (${baseRef}) to compare against.`);
    console.error(`  npm ci  exit=${install.status}\n  tsc -b  exit=${built.status}`);
    console.error("A base that would not build is not evidence that nothing broke.");
    process.exit(2);
  }
} finally {
  sh("git", ["worktree", "remove", "--force", work]).toString?.();
  rmSync(work, { recursive: true, force: true });
}

const breaking = [];
for (const [key, members] of base) {
  if (!head.has(key)) {
    breaking.push(`removed export: ${key}`);
    continue;
  }
  const now = head.get(key) ?? new Set();
  for (const member of now) {
    if (!members.has(member)) breaking.push(`newly required member: ${key}.${member}`);
  }
}

if (breaking.length === 0) {
  console.log(`No breaking surface change against ${baseRef}.`);
  console.log(
    "Not checked: whether a change is semantically breaking. A field whose meaning changed " +
      "while its type did not is invisible here.",
  );
  process.exit(0);
}

// The section is bound to **this tree's version**, and every finding must appear in it.
//
// The first version of this check accepted any `BREAKING` string in the newest two sections. Three
// ways that passes while the notes are wrong, all found by review rather than by use: a heading
// left over from the *previous* release covers a new one that documents nothing; one documented
// finding passes for all of them; and a heading can exist while naming none of the symbols listed
// below it.
//
// That made the pass condition weaker than the tool's own failure message, which says "the
// migration for each" — a check whose green is easier to earn than its red text describes is the
// first failure category living inside the tool built for the third. So the message is now the
// rule.
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");

// The notes for a bump land either under a heading naming the new version, or under `Unreleased`
// before the bump commit. Both are legitimate; a *previous* version's heading is not.
const sections = new Map();
for (const part of changelog.split(/^## /m).slice(1)) {
  sections.set(part.split("\n")[0].trim(), part);
}
const heading = [...sections.keys()].find((key) => key.startsWith(version));
const section = sections.get(heading ?? "") ?? sections.get("Unreleased") ?? "";

if (section === "") {
  console.error(`${breaking.length} breaking surface change(s), and CHANGELOG.md has no section`);
  console.error(`for ${version} and no Unreleased section to hold them.`);
  process.exit(1);
}

// A waiver is explicit, per symbol, and carries a reason — so declining to document a finding is
// a thing someone wrote down rather than a thing nobody noticed.
//   <!-- breaking-waiver: pkg:Symbol.member — why this is not breaking -->
const waived = new Set(
  [...changelog.matchAll(/<!--\s*breaking-waiver:\s*([^\s—-]+)/g)].map((match) => match[1]),
);

const undocumented = breaking.filter((item) => {
  const symbol = item.replace(/^(removed export|newly required member): /, "");
  if (waived.has(symbol)) return false;
  // The section must name the symbol itself, not merely carry the word BREAKING. Matched on the
  // bare name so `SpendGrant.scope` is satisfied by prose naming `SpendGrant` and `scope`.
  return !symbol
    .split(":")[1]
    .split(".")
    .every((part) => section.includes(part));
});

if (!/BREAKING/.test(section)) {
  console.error(`${breaking.length} breaking surface change(s) against ${baseRef}, and the`);
  console.error(`CHANGELOG section for ${heading ?? "Unreleased"} carries no BREAKING entry:\n`);
  for (const item of breaking) console.error(`  ${item}`);
  console.error(
    "\nAn adopter pinned exactly finds these by compiling, and is the last party to know. Add a " +
      "BREAKING section with the migration for each.",
  );
  process.exit(1);
}

if (undocumented.length > 0) {
  console.error(`${undocumented.length} of ${breaking.length} breaking change(s) are not named in`);
  console.error(`the ${heading ?? "Unreleased"} section, which carries a BREAKING entry that does`);
  console.error("not cover them:\n");
  for (const item of undocumented) console.error(`  ${item}`);
  console.error(
    "\nA heading is not coverage. Name each symbol with its migration, or waive it explicitly:\n" +
      "  <!-- breaking-waiver: pkg:Symbol.member — why this is not breaking -->",
  );
  process.exit(1);
}

console.log(
  `${breaking.length} breaking surface change(s), each named in the ${heading ?? "Unreleased"} ` +
    "section.",
);
for (const item of breaking) console.log(`  ${item}`);
if (waived.size > 0) console.log(`\n${waived.size} waiver(s) present in CHANGELOG.md.`);
process.exit(0);
