/**
 * Every `{@link ...}` in published source names something that exists.
 *
 * ADR-0031's subject, at the smallest scale that still bites. `0.2.0-next.18` shipped with
 * `TakeRecord.parameters` documented as *"Read {@link effectiveParameters} for what actually
 * produced the audio"* — a function renamed two commits earlier and exported nowhere. The
 * docstring was correct when written, stayed compiling, and pointed an adopter at a symbol they
 * could not import.
 *
 * TSDoc links are not checked by the compiler, so nothing failed. This is the check.
 *
 * Deliberately shallow: it resolves a name against the declarations in that package's source, not
 * against a resolved symbol table. A link to a symbol that exists but means something else is
 * beyond it. What it catches is the rename, which is the one that actually happened.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every `.ts` under a directory. */
function sources(dir: string): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      if (entry.endsWith(".ts")) found.push(path);
      else if (!entry.includes(".") && statSync(path).isDirectory()) stack.push(path);
    }
  }
  return found;
}

/** Package source directories: the src folder of every aldus package. */
const packages = readdirSync(packagesDir)
  .filter((entry) => entry.startsWith("aldus-"))
  .map((entry) => ({ name: entry, dir: join(packagesDir, entry, "src") }))
  .filter((entry) => {
    try {
      return statSync(entry.dir).isDirectory();
    } catch {
      return false;
    }
  });

/**
 * Names a package's source declares.
 *
 * Includes imported names, because a link may legitimately point at a type this package consumes
 * rather than defines — narrowing that would produce false failures, which is how a check earns
 * being switched off.
 */
function declaredNames(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|function|const|let|enum)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      names.add(match[1] as string);
    }
    // Imported names, including `type X` and `X as Y` forms.
    for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}/g)) {
      for (const part of (match[1] as string).split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name !== undefined && name.length > 0) names.add(name);
      }
    }
    // Members, so `{@link SynthesisOutcome.charged}` resolves, and so does a bare `{@link charged}`
    // written from inside the same declaration. The `?` is what makes an optional property a member
    // rather than a miss — omitting it reported four dangling links of which three were this regex
    // being wrong, and a check with false failures earns being switched off.
    for (const match of source.matchAll(
      /^\s*(?:readonly\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\??\s*[(:<]/gm,
    )) {
      names.add(match[1] as string);
    }
  }
  return names;
}

describe("documentation points at symbols that exist", () => {
  for (const pkg of packages) {
    const files = sources(pkg.dir);
    if (files.length === 0) continue;
    const names = declaredNames(files);

    it(`${pkg.name} has no dangling {@link}`, () => {
      const dangling: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/\{@link\s+([^}|\s]+)/g)) {
          const target = match[1] as string;
          // Only the head of a dotted path is checkable here, and a URL is not a symbol.
          if (target.startsWith("http")) continue;
          const head = target.split(".")[0] as string;
          if (!names.has(head)) dangling.push(`${file.split("/").slice(-2).join("/")}: ${target}`);
        }
      }
      expect(
        dangling,
        "these {@link} targets name nothing this package declares or imports. A rename left the " +
          "prose behind — the compiler does not check TSDoc links, so nothing failed and the " +
          "docstring shipped pointing at a symbol an adopter cannot import.",
      ).toEqual([]);
    });
  }
});
