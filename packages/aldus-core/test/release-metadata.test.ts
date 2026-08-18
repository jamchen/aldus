/**
 * Release metadata invariants (ADR-0020).
 *
 * Lockstep versioning and exact internal pins are only true while every manifest agrees. One
 * package left behind at an older version, or one dependency loosened back to a range, produces
 * a release that installs a composition nobody tested — and npm will resolve it happily.
 *
 * These are cheap assertions guarding an expensive, irreversible mistake: a published version
 * cannot be recalled, only deprecated.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const packagesDir = join(repoRoot, "packages");

/**
 * Packages that must never reach the registry.
 *
 * `@aldus-runtime/e2e` is a test harness, not a product: it exists to prove the composed stack
 * works and has no meaning outside this repository (ADR-0020).
 */
const NEVER_PUBLISHED = new Set(["@aldus-runtime/e2e"]);

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: { access?: string; registry?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const packageDirs = readdirSync(packagesDir).filter((name) =>
  statSync(join(packagesDir, name)).isDirectory(),
);

const manifests: Manifest[] = packageDirs.map(
  (dir) => JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")) as Manifest,
);

const rootVersion = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Manifest)
  .version;

describe("lockstep versioning", () => {
  it("finds packages to check", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it("holds every package at one version", () => {
    const versions = [...new Set(manifests.map((m) => m.version))];
    expect(versions, "packages disagree on the release version").toHaveLength(1);
  });

  it("keeps the workspace root on that same version", () => {
    expect(rootVersion).toBe(manifests[0]?.version);
  });
});

describe("internal dependency pins", () => {
  describe.each(manifests.map((m) => [m.name, m] as const))("%s", (_name, manifest) => {
    it("pins every workspace dependency to the exact release version", () => {
      // A range would let a consumer install a combination that was never tested together.
      // `*` in particular means "any version, forever" — the state this replaced.
      const loose = [
        ...Object.entries(manifest.dependencies ?? {}),
        ...Object.entries(manifest.devDependencies ?? {}),
      ]
        .filter(([dep]) => dep.startsWith("@aldus-runtime/"))
        .filter(([, range]) => range !== manifest.version)
        .map(([dep, range]) => `${dep}@${range}`);
      expect(loose).toEqual([]);
    });
  });
});

describe("publish surface", () => {
  describe.each(manifests.map((m) => [m.name, m] as const))("%s", (name, manifest) => {
    const shouldPublish = !NEVER_PUBLISHED.has(name);

    it(shouldPublish ? "is publishable" : "is permanently private", () => {
      // `private: true` is what actually stops `npm publish`; anything else is a convention.
      expect(manifest.private ?? false).toBe(!shouldPublish);
    });

    if (shouldPublish) {
      it("targets the public registry explicitly", () => {
        // A scoped package defaults to restricted access. Without this, a publish either fails
        // or succeeds privately — and a privately published name is still taken.
        expect(manifest.publishConfig?.access).toBe("public");
        expect(manifest.publishConfig?.registry).toBe("https://registry.npmjs.org");
      });
    } else {
      it("declares no publishConfig, so nothing suggests it is publishable", () => {
        expect(manifest.publishConfig).toBeUndefined();
      });
    }
  });
});
