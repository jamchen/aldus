/**
 * Which workspace packages are published, and which never are.
 *
 * One module owns this question so that the packing script, the clean-consumer gate, and the
 * release workflow cannot disagree about it. A publish set assembled independently in three
 * places is three chances to publish something that should have stayed internal.
 *
 * Plain Node ESM with no dependencies, so it runs from a bare `node` in CI before anything is
 * installed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this file's location rather than the working directory. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Packages that must never reach the registry, by name.
 *
 * This is an allowlist inverted deliberately: `private: true` is honoured as well, but it is a
 * flag a manifest edit can clear by accident, and `@aldus-runtime/e2e` is a test harness whose
 * accidental publication would ship the project's internal scaffolding under a supported name.
 * Two independent mechanisms have to fail before that happens.
 */
export const NEVER_PUBLISH = new Set(["@aldus-runtime/e2e"]);

/** Directory holding the workspace packages. */
const packagesDir = join(repoRoot, "packages");

/** Read and parse one manifest. */
function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every workspace package, published or not, in name order. */
export function allPackages() {
  return readdirSync(packagesDir)
    .filter((entry) => statSync(join(packagesDir, entry)).isDirectory())
    .map((entry) => {
      const dir = join(packagesDir, entry);
      const manifestPath = join(dir, "package.json");
      const manifest = readManifest(manifestPath);
      return { dir, dirName: entry, manifestPath, manifest, name: manifest.name };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The packages that are published.
 *
 * A package is in the set when it is not named in {@link NEVER_PUBLISH}. `private: true` is
 * *not* used to derive the set, because the set must be stable while the manifests are being
 * prepared for a release — the clean-consumer gate has to pack the real publish set before
 * `private` has been cleared. {@link assertReleaseReady} checks `private` separately, at the
 * point where it actually matters.
 */
/**
 * The repository every published package must point at, in npm's canonical spelling.
 *
 * Declared once because three places knew this string independently — the manifests, the
 * licensing test, and this check — and changing two of them left the release gate refusing a
 * release that was otherwise correct. Exported so the mismatch cannot recur silently.
 */
export const REPOSITORY_URL = "git+https://github.com/jamchen/aldus.git";

export function publishSet() {
  return allPackages().filter((pkg) => !NEVER_PUBLISH.has(pkg.name));
}

/** Packages deliberately excluded. */
export function excludedPackages() {
  return allPackages().filter((pkg) => NEVER_PUBLISH.has(pkg.name));
}

/**
 * Fail loudly if anything that must never publish has reached a set.
 *
 * Called by every consumer of {@link publishSet} rather than trusted to have been called once,
 * because the cost of the check is nothing and the cost of missing it is a published test
 * harness that cannot be unpublished after 72 hours.
 */
export function assertNothingForbidden(packages) {
  const forbidden = packages.filter((pkg) => NEVER_PUBLISH.has(pkg.name)).map((pkg) => pkg.name);
  if (forbidden.length > 0) {
    throw new Error(
      `Refusing to proceed: ${forbidden.join(", ")} must never be published. ` +
        "See NEVER_PUBLISH in scripts/publish-set.mjs.",
    );
  }
}

/**
 * Assert the publish set is actually releasable.
 *
 * Separate from {@link publishSet} because these are release-time conditions: the set is the
 * same during development, when none of them hold yet.
 */
export function assertReleaseReady(packages = publishSet()) {
  assertNothingForbidden(packages);
  const problems = [];

  for (const { name, manifest } of packages) {
    if (manifest.private === true) {
      problems.push(`${name}: still marked "private": true, so npm publish would refuse it`);
    }
    if (manifest.version === "0.0.0") {
      problems.push(`${name}: version is still 0.0.0`);
    }
    if (manifest.license !== "Apache-2.0") {
      problems.push(`${name}: license is ${JSON.stringify(manifest.license)}, expected Apache-2.0`);
    }
    // npm's canonical spelling. A plain `https://…` is accepted and then rewritten on publish,
    // so the manifests carry the form that actually reaches the registry (see licensing.test.ts).
    if (manifest.repository?.url !== REPOSITORY_URL) {
      problems.push(`${name}: repository.url must be the canonical repository for provenance`);
    }
    if (manifest.publishConfig?.access !== "public") {
      problems.push(`${name}: publishConfig.access must be "public" for a scoped package`);
    }
    for (const required of ["LICENSE", "NOTICE"]) {
      if (!(manifest.files ?? []).includes(required)) {
        problems.push(`${name}: ${required} is not in files[], so it would not reach a consumer`);
      }
    }
  }

  // Lockstep: one version across the whole set (ADR-0020).
  const versions = [...new Set(packages.map((pkg) => pkg.manifest.version))];
  if (versions.length > 1) {
    problems.push(`versions are not lockstep: found ${versions.sort().join(", ")}`);
  }

  // Exact internal pins: the first release installs the composition that was tested (ADR-0020).
  const expected = versions[0];
  for (const { name, manifest } of packages) {
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!dep.startsWith("@aldus-runtime/")) continue;
      if (NEVER_PUBLISH.has(dep)) {
        problems.push(`${name}: depends on ${dep}, which is never published`);
      }
      if (range !== expected) {
        problems.push(
          `${name}: dependency ${dep} is "${range}", expected the exact pin "${expected}"`,
        );
      }
    }
  }

  return { ok: problems.length === 0, problems, version: expected };
}

/** True when this module is the entry point. */
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const set = publishSet();
  const excluded = excludedPackages();
  assertNothingForbidden(set);
  const readiness = assertReleaseReady(set);

  console.log(`Publish set (${set.length}):`);
  for (const pkg of set) console.log(`  ${pkg.name}@${pkg.manifest.version}`);
  console.log(`\nNever published (${excluded.length}):`);
  for (const pkg of excluded) console.log(`  ${pkg.name}`);

  if (readiness.ok) {
    console.log(`\nRelease-ready at ${readiness.version}.`);
  } else {
    console.log("\nNot release-ready:");
    for (const problem of readiness.problems) console.log(`  - ${problem}`);
    if (process.argv.includes("--strict")) process.exit(1);
  }
}
