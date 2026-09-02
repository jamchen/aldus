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
 * - a required member appearing on an exported type that did not have it;
 * - a member-bearing exported interface surviving under a non-interface declaration kind.
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

import {
  breakingFindings,
  declarationSurface,
  emptyDeclarationSurface,
  mergeDeclarationSurface,
  parseWaivers,
  selectSection,
  uncoveredFindings,
} from "./breaking-coverage.mjs";
import { declineMissingBaseRef } from "./declined.mjs";

const baseRef = process.argv[2];
if (baseRef === undefined) declineMissingBaseRef("check-breaking-notes.mjs", "origin/main");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();

/** Every exported symbol, and the required members of each exported type, from built `.d.ts`. */
function surfaceOf(root) {
  // Accumulated by union — `mergeDeclarationSurface`, never `Map.set` per file. A package's export
  // surface is the union of its emitted `.d.ts` files, and one symbol's legal type/value merge can
  // land in two of them.
  const whole = emptyDeclarationSurface();
  const pkgDir = join(root, "packages");
  if (!existsSync(pkgDir)) return whole;
  const dts = sh("bash", [
    "-c",
    `find ${JSON.stringify(pkgDir)} -path '*/dist/*.d.ts' -not -path '*/node_modules/*' | sort`,
  ]);
  for (const file of dts.split("\n").filter(Boolean)) {
    const pkg = file.slice(pkgDir.length + 1).split("/")[0];
    mergeDeclarationSurface(whole, declarationSurface(readFileSync(file, "utf8"), pkg));
  }
  return whole;
}

const repoRoot = sh("git", ["rev-parse", "--show-toplevel"]);
const { surface: head, opaque: headOpaque, declarations: headDeclarations } = surfaceOf(repoRoot);
if (head.size === 0) {
  console.error("DECLINED: no built .d.ts found at HEAD — run `npm run build` first.");
  console.error("A missing build is not the same answer as a clean surface.");
  process.exit(2);
}

// The base is built in a throwaway worktree, because the surface has to come from the base's own
// compiler output. Reading the base's *source* would answer a different question.
const work = mkdtempSync(join(tmpdir(), "aldus-breaking-"));
let base;
let baseOpaque = new Map();
let baseDeclarations = new Map();
try {
  sh("git", ["worktree", "add", "--detach", work, baseRef]);
  const install = spawnSync("npm", ["ci", "--ignore-scripts"], { cwd: work, encoding: "utf8" });
  const built = spawnSync("npx", ["tsc", "-b"], { cwd: work, encoding: "utf8" });
  ({ surface: base, opaque: baseOpaque, declarations: baseDeclarations } = surfaceOf(work));
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

const breaking = breakingFindings(base, head, baseDeclarations, headDeclarations);

// The blind spot, named rather than left implicit. These are exported interfaces whose bodies are
// Zod-inferred, so a newly required member reads identically to an existing one and the check above
// cannot classify them. Listing the ones whose body actually changed turns "the tool cannot see
// this" into "the tool knows what it cannot see", which is the difference between a reader who can
// go and look and one who has no reason to.
//
// Surfaced, never refused. Refusing would fire on every additive schema change — which is most of
// them — and a red that is usually wrong is a red people learn to clear rather than read. Same split
// as `evidence.mjs`: refuse the mechanical half, surface the judgement half.
const opaqueChanged = [];
for (const [key, digest] of headOpaque) {
  const before = baseOpaque.get(key);
  if (before !== undefined && before !== digest) opaqueChanged.push(key);
}
function reportOpaque() {
  if (opaqueChanged.length === 0) return;
  console.log(
    `\nNot classifiable (${opaqueChanged.length}): Zod-inferred exported type(s) whose shape ` +
      "changed.",
  );
  for (const key of opaqueChanged) console.log(`  ${key}`);
  console.log(
    "Optionality here lives in `z.ZodOptional<…>` rather than in a `?`, so a newly required " +
      "member\nis invisible to this check. If one of these gained a required member, that is a " +
      "break and\nneeds a CHANGELOG entry nothing here will demand.",
  );
}

if (breaking.length === 0) {
  console.log(`No breaking surface change against ${baseRef}.`);
  console.log(
    "Not checked: whether a change is semantically breaking. A field whose meaning changed " +
      "while its type did not is invisible here.",
  );
  reportOpaque();
  process.exit(0);
}

// The admission rule lives in `breaking-coverage.mjs` as pure functions, so its false-green paths
// are tested without a worktree and a build. See `packages/aldus-e2e/test/breaking-coverage.test.ts`.
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const selected = selectSection(changelog, version);

// Absence and ambiguity both refuse. The rule this replaces resolved duplicate headings by keeping
// the last one, so a release with two sections was read from whichever came later in the file —
// silently, and in this repository's own CHANGELOG that was the superseded text of `0.2.0-next.49`.
// A gate that decides whether an adopter is told about a breaking change may not pick between two
// disagreeing bodies on file order.
if (!selected.ok) {
  console.error(`${breaking.length} breaking surface change(s), and CHANGELOG.md cannot bind them`);
  console.error(`to exactly one section (${selected.reason}):\n`);
  console.error(selected.diagnostic);
  process.exit(1);
}

const { heading, body } = selected;

const { waived, malformed } = parseWaivers(body);
if (malformed.length > 0) {
  console.error(`${malformed.length} malformed waiver(s) in the ${heading} section:\n`);
  for (const item of malformed) console.error(`  <!-- breaking-waiver: ${item} -->`);
  console.error(
    "\nA waiver states a symbol and a reason:\n" +
      "  <!-- breaking-waiver: pkg:Symbol.member — why this is not breaking -->\n" +
      "One without a reason is malformed, not lenient.",
  );
  process.exit(1);
}

const uncovered = uncoveredFindings(breaking, body, waived);

if (!/BREAKING/.test(body)) {
  console.error(`${breaking.length} breaking surface change(s) against ${baseRef}, and the`);
  console.error(`CHANGELOG section for ${heading} carries no BREAKING entry:\n`);
  for (const item of breaking) console.error(`  ${item}`);
  console.error(
    "\nAn adopter pinned exactly finds these by compiling, and is the last party to know. Add a " +
      "BREAKING section with the migration for each, and mark each one:\n" +
      "  <!-- breaking: pkg:Symbol.member -->",
  );
  process.exit(1);
}

if (uncovered.length > 0) {
  console.error(`${uncovered.length} of ${breaking.length} breaking change(s) are not marked in`);
  console.error(`the ${heading} section:\n`);
  for (const item of uncovered) console.error(`  ${item}`);
  console.error(
    "\nA heading is not coverage, and prose is not a match — a type name and a member name in " +
      "unrelated sentences would satisfy a text search. Mark each finding explicitly:\n" +
      "  <!-- breaking: pkg:Symbol.member -->\n" +
      "or waive it with a reason:\n" +
      "  <!-- breaking-waiver: pkg:Symbol.member — why this is not breaking -->",
  );
  process.exit(1);
}

console.log(
  `${breaking.length} breaking surface change(s), each marked in the ${heading} section.`,
);
for (const item of breaking) console.log(`  ${item}`);
reportOpaque();
if (waived.size > 0) {
  console.log(`\n${waived.size} waiver(s) in this section:`);
  for (const [symbol, reason] of waived) console.log(`  ${symbol} — ${reason}`);
}
process.exit(0);
