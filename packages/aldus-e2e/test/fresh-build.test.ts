/**
 * The tests in this package must be running the code you just changed.
 *
 * Every other package's tests import `../src/*.js`, so vitest loads the source directly and what
 * you edited is what runs. This package is different: it composes the workspace through
 * `@aldus-runtime/*` package entry points, and those resolve to `dist/`. Nothing rebuilds on the
 * way in. So editing a source file and running these tests directly exercises the *previous*
 * build, silently, and reports green.
 *
 * That failure is worse than it sounds, because of what it is indistinguishable from. A mutation
 * that was never loaded and a mutation that had no effect produce identical output — a passing
 * test. The comfortable conclusion is "the guard is unnecessary" or "my test is weak", and both
 * are wrong in the same direction: the experiment never ran. Nothing in the result says so.
 *
 * `npm run verify` builds before testing, so this only bites a direct vitest invocation — which
 * is exactly what someone does while iterating on a fix, and exactly when a false green is most
 * expensive.
 *
 * Reported by the first adopter, who hit it twice in one migration while proving a fix. Related:
 * ADR-0031, where the stale artifact is a build and the reader it misleads is a person.
 */

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Newest mtime under `directory`, or 0 if it does not exist. */
async function newestMtime(directory: string): Promise<number> {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtime(path));
    } else {
      newest = Math.max(newest, (await stat(path)).mtimeMs);
    }
  }
  return newest;
}

describe("the composed stack under test is built from current sources", () => {
  it("has no package whose src is newer than its last build", async () => {
    const packagesDir = join(repoRoot, "packages");
    const stale: string[] = [];

    for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = join(packagesDir, entry.name);

      // `tsc -b` rewrites this on every successful build, including builds whose emitted output
      // is unchanged. Comparing against dist/ directly would report a false stale whenever a
      // source edit produced identical JS.
      let builtAt: number;
      try {
        builtAt = (await stat(join(packageRoot, "tsconfig.tsbuildinfo"))).mtimeMs;
      } catch {
        continue; // Never built, or not a compiled package. Not this test's business.
      }

      const editedAt = await newestMtime(join(packageRoot, "src"));
      if (editedAt > builtAt) stale.push(entry.name);
    }

    expect(
      stale,
      `these packages have source changes that are not in the build these tests load, so a pass ` +
        `here says nothing about them — run \`npm run build\`: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
