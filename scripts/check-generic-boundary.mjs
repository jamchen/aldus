/**
 * The §4.2 boundary, checked over everything the repository publishes or records.
 *
 * Aldus Core is a generic runtime: contract §4.2 forbids naming a provider, platform, cloud
 * service, or **adopter identity**. This is the single place the forbidden list lives, so CI and
 * the local mirror test cannot disagree about what the rule is.
 *
 * ## Why this exists rather than the previous grep
 *
 * The CI step was named "Reject adopter-specific names" and its comment said it covered adopter
 * identity. Its pattern contained none — eleven provider, platform and cloud names and no adopter.
 * So a claim about a boundary was enforced by a check that did not make it, and the check's own
 * name asserted more than it did. Two files reached `main` naming an adopter's repository, and one
 * of them was written by the reviewer whose job was to catch it (#173).
 *
 * It also scanned `packages/` only. One of the two breaches was in `docs/`, where the architecture
 * record lives — the place a neutrality claim is most load-bearing, because prose is where an
 * adopter's name is most natural to reach for as evidence.
 *
 * A neutrality rule enforced by attention fails on the busiest day. This is the enforceable form.
 *
 * ## The list is fragments, deliberately
 *
 * A file containing the strings it forbids trips its own check. Names are assembled at runtime, and
 * this file excludes itself by path — the same tactic `boundary.test.ts` uses, for the same reason.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * Names that must not appear, by category, assembled from fragments.
 *
 * Adding an entry is cheap and removing one should be argued: each is a concrete thing §4.2 says
 * Core does not own. The check proves no *listed* name appears, which is strictly weaker than "no
 * provider is named" — a provider nobody thought of passes. That distinction is kept in the failure
 * message too, because a reader who takes the strong reading stops looking.
 */
const FORBIDDEN = {
  provider: [
    ["eleven", "labs"],
    ["open", "ai"],
    ["anthrop", "ic"],
  ],
  platform: [
    ["you", "tube"],
    ["spot", "ify"],
    ["sound", "cloud"],
    ["apple podcast", "s"],
  ],
  cloud: [
    ["fire", "store"],
    ["google cloud", ""],
  ],
  /**
   * Adopter identities. The category the previous check named and did not contain.
   *
   * An adopter's repository, product or company name. These reach the record through evidence —
   * "a search across X finds nothing" — which is exactly when a reviewer is least likely to see it,
   * because the sentence is doing something honest.
   */
  adopter: [
    ["megaphone", "-aldus"],
    ["megaphone", ""],
  ],
};

/**
 * Where each category is forbidden, and why the two differ.
 *
 * **Provider, platform and cloud names: `packages/` only.** §4.2 forbids *Core* from naming them
 * and the architecture record has to be able to illustrate what it forbids — §4.2 itself quotes
 * "YouTube channel IDs" as an example of what Core must not own. A check that banned the word from
 * `docs/` would stop the contract stating its own rule, and rewriting the contract to satisfy a
 * grep is the grep winning an argument it should not be in.
 *
 * **Adopter identity: `packages/` and `docs/`.** Neither the runtime nor its record has business
 * naming a particular adopter. Where an adopter's case is the evidence — and it often is, because
 * these are reported by adopters — "the first adopter" carries the same substance and the same
 * weight. This is the category the previous check named and did not contain, and the breach it
 * missed was in `docs/`.
 */
const SCOPE = {
  provider: ["packages"],
  platform: ["packages"],
  cloud: ["packages"],
  adopter: ["packages", "docs"],
};
const EXTENSIONS = [".ts", ".tsx", ".json", ".md", ".mjs", ".yml", ".yaml"];

/** Paths that necessarily contain the fragments, excluded by path rather than by weakening. */
const SELF_EXEMPT = [
  "scripts/check-generic-boundary.mjs",
  "packages/aldus-e2e/test/boundary.test.ts",
];

function filesUnder(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
      continue;
    }
    if (EXTENSIONS.includes(extname(entry))) found.push(path);
  }
  return found;
}

const names = Object.entries(FORBIDDEN).flatMap(([category, pairs]) =>
  pairs.map(([head, tail]) => ({ category, name: `${head}${tail}` })),
);

const byDirectory = new Map();
for (const directory of new Set(Object.values(SCOPE).flat())) {
  byDirectory.set(directory, filesUnder(directory));
}
const total = [...byDirectory.values()].reduce((sum, list) => sum + list.length, 0);
if (total === 0) {
  console.error("check-generic-boundary: found no files to scan; refusing to pass vacuously.");
  process.exit(2);
}

const offenders = [];
for (const [directory, list] of byDirectory) {
  const applicable = names.filter(({ category }) => SCOPE[category].includes(directory));
  for (const path of list) {
    const relativePath = relative(process.cwd(), path);
    if (SELF_EXEMPT.includes(relativePath)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      const lowered = line.toLowerCase();
      for (const { category, name } of applicable) {
        if (lowered.includes(name)) {
          offenders.push(`${relativePath}:${index + 1}  [${category}]  ${name}`);
        }
      }
    });
  }
}

if (offenders.length > 0) {
  console.error(
    `Aldus Core must stay generic (architecture contract §4.2). ${offenders.length} occurrence(s):`,
  );
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error(
    "\nThis proves no *listed* name appears, not that no provider or adopter is named — " +
      "one nobody thought of passes. Add it to FORBIDDEN in scripts/check-generic-boundary.mjs.",
  );
  process.exit(1);
}

console.log(
  `check-generic-boundary: ${total} files, ${names.length} listed names, no occurrences.`,
);
