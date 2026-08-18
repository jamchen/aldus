/**
 * ADR index integrity.
 *
 * `docs/adr/README.md` is how architecture decisions stay discoverable. A decision that is
 * written down but not indexed is, in practice, a decision nobody finds — and that is not
 * hypothetical: ADR-0004 was written, committed, and merged to `main` while its index row was
 * silently lost to a failed text substitution. Nothing caught it, because nothing was looking.
 *
 * This suite looks. It is deliberately mechanical: it checks that the index and the directory
 * agree, not that any ADR says something sensible.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const adrDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "adr");

/** ADR files on disk, as `NNNN-kebab-title.md`, excluding the index itself. */
const adrFiles = readdirSync(adrDir)
  .filter((name) => /^\d{4}-.+\.md$/.test(name))
  .sort();

const index = readFileSync(join(adrDir, "README.md"), "utf8");

/** Filenames the index links to, in the order it lists them. */
const linkedFiles = [...index.matchAll(/\[(\d{4})\]\((\d{4}-[^)]+\.md)\)/g)].map((match) => ({
  number: match[1] ?? "",
  file: match[2] ?? "",
}));

describe("ADR index", () => {
  it("finds ADRs on disk", () => {
    // Guards against the whole suite passing vacuously if the directory moves.
    expect(adrFiles.length).toBeGreaterThan(0);
  });

  it("links every ADR file that exists", () => {
    const linked = new Set(linkedFiles.map((entry) => entry.file));
    const unlisted = adrFiles.filter((file) => !linked.has(file));
    expect(unlisted, "these ADRs exist but are not listed in docs/adr/README.md").toEqual([]);
  });

  it("links no ADR file that does not exist", () => {
    const onDisk = new Set(adrFiles);
    const dangling = linkedFiles.map((entry) => entry.file).filter((file) => !onDisk.has(file));
    expect(dangling, "the index links these files, but they are missing").toEqual([]);
  });

  it("labels each link with the number in its filename", () => {
    const mismatched = linkedFiles
      .filter((entry) => !entry.file.startsWith(`${entry.number}-`))
      .map((entry) => `[${entry.number}] → ${entry.file}`);
    expect(mismatched).toEqual([]);
  });

  it("lists ADRs in ascending order", () => {
    const numbers = linkedFiles.map((entry) => entry.number);
    expect(numbers).toEqual([...numbers].sort());
  });

  it("gives every ADR a status", () => {
    // A decision with no status cannot be told apart from a draft someone abandoned.
    const missing = adrFiles.filter((file) => {
      const body = readFileSync(join(adrDir, file), "utf8");
      return !/^-\s*Status:\s*(Proposed|Accepted|Superseded by ADR-\d{4}|Deprecated)\s*$/m.test(
        body,
      );
    });
    expect(missing, "these ADRs have no recognised Status line").toEqual([]);
  });
});
