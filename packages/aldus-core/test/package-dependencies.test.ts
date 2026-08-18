/**
 * Runtime dependency correctness.
 *
 * npm workspaces symlink every package into the root `node_modules`, so a package can import
 * something it never declared and the build, the type checker, and the whole test suite will
 * pass. In a published tarball the consumer gets only what `dependencies` names, and the very
 * first `import` fails at runtime.
 *
 * This is not hypothetical: both `@aldus-runtime/cli` and `@aldus-runtime/mcp` shipped that
 * defect, each importing three workspace packages declared only as `devDependencies`, and the
 * CLI constructed them at runtime rather than merely referencing their types. Nothing caught it
 * until a package was inspected for publishing.
 *
 * The rule this enforces: **anything `src/` imports is a `dependency`.** `devDependencies` are
 * for what only `test/` and tooling touch.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const packagesDir = join(repoRoot, "packages");

/**
 * `import … from "x"`, `export … from "x"`, and bare `import "x"`.
 *
 * Applied only after comments are stripped. Prose routinely contains the word `from` followed
 * by a quoted phrase — this check first reported the phrase "a firm pause here" as a missing
 * dependency, having matched it inside a TSDoc block. Scanning raw source for imports is
 * unreliable in a codebase that documents itself heavily.
 */
const FROM_SPECIFIER = /^\s*(?:import|export)\s[^;"']*?\sfrom\s+["']([^"']+)["']/gm;
const BARE_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;

/**
 * Remove block comments, line comments, and string literals' contents.
 *
 * Import specifiers survive because they are matched against the stripped text where only
 * *comment* text is gone; string literals are left intact so specifiers remain readable.
 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    const ch = source[index] ?? "";
    if (mode === "code") {
      if (two === "//") {
        mode = "line";
        index += 2;
        continue;
      }
      if (two === "/*") {
        mode = "block";
        index += 2;
        continue;
      }
      if (ch === "'") mode = "single";
      else if (ch === '"') mode = "double";
      else if (ch === "`") mode = "template";
      out += ch;
      index += 1;
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out += ch;
      }
      index += 1;
      continue;
    }
    if (mode === "block") {
      if (two === "*/") {
        mode = "code";
        index += 2;
        continue;
      }
      // Keep newlines so line-anchored patterns still see the right structure.
      if (ch === "\n") out += ch;
      index += 1;
      continue;
    }
    // Inside a string literal: copy verbatim, honouring escapes.
    if (ch === "\\") {
      out += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (
      (mode === "single" && ch === "'") ||
      (mode === "double" && ch === '"') ||
      (mode === "template" && ch === "`")
    ) {
      mode = "code";
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** Reduce a module specifier to the package it resolves to. */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return undefined;
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** Every external package imported from a directory tree. */
function importedPackages(dir: string): Set<string> {
  const packages = new Set<string>();
  for (const file of tsFilesUnder(dir)) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const pattern of [FROM_SPECIFIER, BARE_IMPORT]) {
      pattern.lastIndex = 0; // these carry /g; a stale lastIndex silently skips matches
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        const name = packageOf(match[1] ?? "");
        if (name !== undefined) packages.add(name);
      }
    }
  }
  return packages;
}

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const packageDirs = readdirSync(packagesDir).filter((name) =>
  statSync(join(packagesDir, name)).isDirectory(),
);

describe("runtime dependencies", () => {
  it("finds packages to check", () => {
    expect(packageDirs.length).toBeGreaterThan(0);
  });

  describe.each(packageDirs)("%s", (dir) => {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, dir, "package.json"), "utf8"),
    ) as Manifest;
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const dev = new Set(Object.keys(manifest.devDependencies ?? {}));
    const imported = importedPackages(join(packagesDir, dir, "src"));

    it("imports something", () => {
      // Without this a package with an unreadable src/ would pass every check below.
      expect(imported.size).toBeGreaterThan(0);
    });

    it("declares every package its src/ imports as a dependency", () => {
      const undeclared = [...imported].filter((name) => !declared.has(name)).sort();
      expect(
        undeclared,
        `${manifest.name}: src/ imports these but they are not in dependencies` +
          `${undeclared.some((name) => dev.has(name)) ? " (some are devDependencies, which do not ship)" : ""}`,
      ).toEqual([]);
    });

    it("does not list a src/ import as a devDependency only", () => {
      const devOnly = [...imported].filter((name) => dev.has(name) && !declared.has(name)).sort();
      expect(devOnly).toEqual([]);
    });
  });
});
