/**
 * Licensing metadata.
 *
 * Apache-2.0 §4(a) requires that anyone receiving a distribution also receives a copy of the
 * License. Our `LICENSE` lives at the monorepo root, which npm does **not** include in a
 * workspace package's tarball — so without a per-package copy every published artifact would
 * ship without its license, and nothing about the build would look wrong.
 *
 * These checks are cheap and the failure they prevent is silent, which is the whole argument
 * for having them.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const packagesDir = join(repoRoot, "packages");

const rootLicense = readFileSync(join(repoRoot, "LICENSE"), "utf8");
const rootNotice = readFileSync(join(repoRoot, "NOTICE"), "utf8");

const packageDirs = readdirSync(packagesDir).filter((name) =>
  statSync(join(packagesDir, name)).isDirectory(),
);

interface Manifest {
  name?: string;
  license?: string;
  files?: string[];
  repository?: { type?: string; url?: string; directory?: string };
}

function manifestOf(dir: string): Manifest {
  return JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")) as Manifest;
}

describe("root LICENSE", () => {
  it("is the Apache License 2.0", () => {
    expect(rootLicense).toContain("Apache License");
    expect(rootLicense).toContain("Version 2.0, January 2004");
  });

  it("retains every operative section", () => {
    for (const section of [
      "1. Definitions",
      "2. Grant of Copyright License",
      "3. Grant of Patent License",
      "4. Redistribution",
      "5. Submission of Contributions",
      "6. Trademarks",
      "7. Disclaimer of Warranty",
      "8. Limitation of Liability",
      "9. Accepting Warranty",
    ]) {
      expect(rootLicense, `LICENSE is missing "${section}"`).toContain(section);
    }
  });
});

describe("root NOTICE", () => {
  // Creating a NOTICE is this project's choice; Apache-2.0 §4(d) governs *preserving* one that
  // already exists rather than requiring one be made. Having made that choice, the propagation
  // obligation is now real, which is what the per-package checks below enforce.
  it("names the copyright holder", () => {
    expect(rootNotice).toContain("Copyright 2026 Jam Chen");
  });

  it("does not restate the licence text, only the attribution and its pointer", () => {
    // A NOTICE that duplicates the licence invites the two drifting apart.
    expect(rootNotice).not.toContain("TERMS AND CONDITIONS");
    expect(rootNotice).toContain("LICENSE");
  });
});

describe("workspace packages", () => {
  it("finds packages to check", () => {
    // Guards against the whole suite passing vacuously if the layout moves.
    expect(packageDirs.length).toBeGreaterThan(0);
  });

  describe.each(packageDirs)("%s", (dir) => {
    const manifest = manifestOf(dir);

    it("declares Apache-2.0", () => {
      expect(manifest.license).toBe("Apache-2.0");
    });

    it("carries a byte-identical copy of the root LICENSE", () => {
      // A drifted copy is worse than a missing one: it looks compliant.
      const packaged = readFileSync(join(packagesDir, dir, "LICENSE"), "utf8");
      expect(packaged).toBe(rootLicense);
    });

    it("includes LICENSE in the published files", () => {
      // Without this the copy exists in the repository and still never reaches a consumer.
      expect(manifest.files ?? []).toContain("LICENSE");
    });

    it("carries a byte-identical copy of the root NOTICE", () => {
      const packaged = readFileSync(join(packagesDir, dir, "NOTICE"), "utf8");
      expect(packaged).toBe(rootNotice);
    });

    it("includes NOTICE in the published files", () => {
      expect(manifest.files ?? []).toContain("NOTICE");
    });

    it("points at the canonical repository, with its own directory", () => {
      // npm provenance resolves a package back to its source through these fields.
      //
      // The `git+…​.git` form is npm's own canonical spelling, not a preference. A plain
      // `https://github.com/jamchen/aldus` is accepted and then **rewritten on publish** — the
      // published 0.1.0 metadata records the git+ form regardless of what the manifest said,
      // with a `npm pkg fix` warning on every package. Keeping the plain form bought a warning
      // twelve times over and a source that disagreed with the registry.
      expect(manifest.repository?.url).toBe("git+https://github.com/jamchen/aldus.git");
      expect(manifest.repository?.directory).toBe(`packages/${dir}`);
    });
  });
});
