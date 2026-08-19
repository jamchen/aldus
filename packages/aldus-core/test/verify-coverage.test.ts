/**
 * `npm run verify` must not silently cover less than it did yesterday.
 *
 * The root scripts fan out with `--workspaces --if-present`, which is right for a workspace that
 * legitimately has nothing to run and wrong as a safety property: a package that loses its `test`
 * script, or a new package added without one, is skipped in silence. `verify` still exits 0, and
 * its last line is the final package's "N passed" — from which a reader infers everything ran.
 *
 * That is the class the first adopter hit four separate times on their own instruments: a check
 * reporting success it had not earned. They fixed each instance; the generalisation is that a
 * harness must state what it established, and `--if-present` is a harness declining to.
 *
 * This is the smallest thing that makes the fan-out honest. It cannot state coverage at the end
 * of a shell pipeline, so it asserts the precondition instead: every package participates, so
 * `--if-present` can never be the reason one did not.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const packagesDir = join(repoRoot, "packages");

/** Scripts the root fans out with `--if-present`, and therefore can skip without saying so. */
const FANNED_OUT = ["test", "typecheck:test"] as const;

function manifestOf(packageName: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(packagesDir, packageName, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
}

const packageNames = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("verify covers every package (the --if-present hole)", () => {
  it("finds packages to check", () => {
    // Guards against passing vacuously if the layout moves — the same failure one level up.
    expect(packageNames.length).toBeGreaterThan(0);
  });

  it.each(FANNED_OUT)("every package defines a %s script", (script) => {
    const missing = packageNames.filter((name) => manifestOf(name).scripts?.[script] === undefined);

    expect(
      missing,
      `\`npm run ${script} --workspaces --if-present\` would skip these in silence, so verify ` +
        `would cover less and still exit 0: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the root fan-out pointed at every workspace", () => {
    // If a root script stops using --workspaces, the per-package assertions above keep passing
    // while nothing runs them. The precondition and the fan-out have to be checked together, or
    // this test becomes the thing it exists to prevent.
    const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const script of FANNED_OUT) {
      expect(root.scripts[script], `root "${script}" must fan out to every workspace`).toContain(
        "--workspaces",
      );
    }
  });
});
