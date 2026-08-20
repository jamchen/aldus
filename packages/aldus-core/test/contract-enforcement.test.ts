/**
 * The contract-enforcement matrix is checked, not merely maintained.
 *
 * `docs/CONTRACT-ENFORCEMENT.md` records where each normative clause of §§12, 13 and 19 is
 * enforced and where it deliberately is not. A document nobody checks is a document that goes
 * stale silently, which is ADR-0031's whole subject — so this parses it and fails when a row
 * claims an enforcement point that does not exist or names a test file that is not there.
 *
 * What it cannot do is prove the semantics. A row can name a real symbol in a real file and be
 * wrong about what that symbol does. What it makes impossible is the specific failure that
 * produced four gaps in one day: **a clause enforced at one point, with nothing recording that the
 * neighbouring point has nothing.**
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const matrix = readFileSync(join(repoRoot, "docs", "CONTRACT-ENFORCEMENT.md"), "utf8");

/** One claim: a clause, the symbol enforcing it, and the test proving it. */
interface Row {
  clause: string;
  contract: string;
  enforcedAt: string;
  provenBy: string;
}

/** Every table row that names an enforcement point, from every §-table in the document. */
function rows(): Row[] {
  const parsed: Row[] = [];
  for (const line of matrix.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/`/g, ""));
    if (cells.length !== 4) continue;
    const [clause, contract, enforcedAt, provenBy] = cells as [string, string, string, string];
    // Header and separator rows.
    if (clause === "Clause" || clause.startsWith("---") || contract === "Contract") continue;
    if (!provenBy.includes("/")) continue;
    parsed.push({ clause, contract, enforcedAt, provenBy });
  }
  return parsed;
}

const CLAIMS = rows();

/** `package:symbol` → the source directory to search. */
function packageDirOf(reference: string): string | undefined {
  const [pkg] = reference.split(":");
  if (pkg === undefined) return undefined;
  const dir = join(repoRoot, "packages", `aldus-${pkg}`, "src");
  return existsSync(dir) ? dir : undefined;
}

/** Whether a symbol appears anywhere in a package's source. */
function symbolExists(reference: string): boolean {
  const dir = packageDirOf(reference);
  const symbol = reference.split(":")[1];
  if (dir === undefined || symbol === undefined) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSyncSafe(current)) {
      const path = join(current, entry);
      if (entry.endsWith(".ts")) {
        if (readFileSync(path, "utf8").includes(symbol)) return true;
      } else if (!entry.includes(".")) {
        stack.push(path);
      }
    }
  }
  return false;
}

function readdirSyncSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

describe("the contract-enforcement matrix describes something that exists (#115)", () => {
  it("finds claims to check", () => {
    // Guards against passing vacuously if the table format changes — the same failure the table
    // exists to prevent, one level up.
    expect(CLAIMS.length).toBeGreaterThan(10);
  });

  it.each(CLAIMS.map((row) => [row.clause, row] as const))(
    "%s names a test file that exists",
    (_clause, row) => {
      expect(
        existsSync(join(repoRoot, row.provenBy)),
        `the matrix says this clause is proven by "${row.provenBy}", and that file is not there. ` +
          "A claim with no test is a claim.",
      ).toBe(true);
    },
  );

  it.each(
    CLAIMS.filter((row) => row.enforcedAt.includes(":")).map((row) => [row.clause, row] as const),
  )("%s names an enforcement point that exists", (_clause, row) => {
    expect(
      symbolExists(row.enforcedAt),
      `the matrix says this clause is enforced at "${row.enforcedAt}", and that symbol is not ` +
        "in that package. Either the enforcement moved and the matrix did not, or it was never " +
        "there.",
    ).toBe(true);
  });

  it("gives every deliberate non-application a reason", () => {
    // The half that makes the matrix honest. "Not applicable to: Workers." with no reason is an
    // omission wearing a decision's clothes, and it is exactly what a reader would take as settled.
    const sections = matrix.split("**Not applicable to:**").slice(1);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      const claim = section.split("\n\n")[0] ?? "";
      expect(
        claim.length,
        `a "Not applicable to" entry is too short to contain a reason: "${claim.trim()}"`,
      ).toBeGreaterThan(80);
    }
  });

  it("records what is not yet enforced rather than omitting it", () => {
    // A matrix listing only what works reads as complete. #107's composed path is contracted and
    // unwired, and the table says so — which is the state this document exists to make visible.
    expect(matrix).toContain("Not yet enforced");
  });
});
