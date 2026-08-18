/**
 * Structural guarantees (architecture contract §15.1, §4.2).
 *
 * Two of this package's three central claims are claims about what it *cannot* do, and a claim
 * like that is worth nothing if nothing checks it. These tests read the package's own source.
 *
 * They are mechanical on purpose. They cannot tell whether the ledger models synthesis well; they
 * can tell whether someone has quietly given it the ability to perform synthesis, or named a
 * provider in it — both of which would be easy to do by accident and hard to notice in review.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Strip comments.
 *
 * The two families of check below want different inputs, and getting that wrong makes a guard
 * fire on its own documentation. The structural checks ask "can this code reach a provider?",
 * which is a question about code — the first draft of this file matched the prose "a plan will
 * synthesise (contract §13.2)" and reported `request.ts` as suspicious. The §4.2 name checks ask
 * "does this package name a provider?", which is a question about the whole file, comments
 * included, because a comment naming one is still the boundary breaking.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sources = readdirSync(srcDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => {
    const text = readFileSync(join(srcDir, name), "utf8");
    return { name, text, code: stripComments(text) };
  });

describe("the package cannot perform synthesis (§15.1)", () => {
  it("has sources to check", () => {
    // Guards against the whole suite passing vacuously if the directory moves.
    expect(sources.length).toBeGreaterThan(5);
  });

  // §15.1: "Aldus MUST NOT silently retry paid requests without policy and cost authorization."
  // The strongest form of that guarantee is a component with no way to make a request at all.
  it.each([
    ["node:http", /["']node:https?["']/],
    ["node:net", /["']node:(net|tls|dgram)["']/],
    ["fetch", /\bfetch\s*\(/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["WebSocket", /\bnew\s+WebSocket\b/],
    ["child_process", /["']node:child_process["']/],
  ])("never reaches for %s", (_label, pattern) => {
    const offenders = sources.filter((source) => pattern.test(source.code)).map((s) => s.name);
    expect(offenders).toEqual([]);
  });

  it("declares no HTTP or provider client as a dependency", () => {
    const manifest = JSON.parse(readFileSync(join(srcDir, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // Every runtime dependency is an Aldus package or the schema library. A provider SDK
    // appearing here would be the boundary breaking (§4.2) and the "cannot synthesise" property
    // failing at the same time.
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(name === "zod" || name.startsWith("@aldus-runtime/"), name).toBe(true);
    }
  });

  it("exposes no method that could invoke a caller-supplied performer", () => {
    // A `synthesize(worker)` convenience would reintroduce the ability to spend money from here,
    // even though the network call happened elsewhere. `PerformanceScriptDeriver` is the one
    // injected callable, and it parses text — it cannot reach a provider.
    const suspicious = sources.filter((source) =>
      /\b(synthesize|synthesise|callProvider|performRequest|sendRequest)\s*\(/.test(source.code),
    );
    expect(suspicious.map((source) => source.name)).toEqual([]);
  });
});

describe("the package names no provider (§4.2)", () => {
  // The CI job greps `packages/` for these, but a test that fails locally is a faster signal
  // than one that fails after a push — and the assertion belongs beside the claim it protects.
  const forbidden = [
    ["eleven", "labs"],
    ["open", "ai"],
    ["anthrop", "ic"],
    ["you", "tube"],
    ["spot", "ify"],
    ["fire", "store"],
  ].map(([head, tail]) => `${head}${tail}`);

  it.each(forbidden)("never mentions %s", (name) => {
    const offenders = sources
      .filter((source) => source.text.toLowerCase().includes(name))
      .map((source) => source.name);
    expect(offenders).toEqual([]);
  });

  it("keeps provider, voice, and model as open strings", () => {
    const request = sources.find((source) => source.name === "request.ts");
    // If any of these became `z.enum`, the runtime would be naming providers — §4.2 — and an
    // adopter would have to fork Core to use a voice nobody anticipated.
    expect(request?.text).toContain("provider: nonEmptyString");
    expect(request?.text).toContain("voice: nonEmptyString");
    expect(request?.text).toContain("model: nonEmptyString");
  });
});
