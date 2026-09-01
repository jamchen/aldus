import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_INTERVAL_MS,
  assertDistTags,
  classifyRun,
  evaluatePackage,
  npmReader,
  npmViewArgs,
  readPayload,
} from "../../../scripts/dist-tags-check.mjs";
import type { DistTags, Reading } from "../../../scripts/dist-tags-check.mjs";
import { publishSet, repoRoot } from "../../../scripts/publish-set.mjs";

/**
 * Regression cases for the post-publish dist-tag rule.
 *
 * The subject is a **false green that actually shipped**: Release run 33470723600 published all
 * twelve packages as `0.2.0-next.53` and the immediately following `Assert dist-tags after
 * publishing` step exited 0 while printing `next: 0.2.0-next.52` for `@aldus-runtime/testkit` and
 * `@aldus-runtime/tts-ledger`. Two independent faults produced it, and each has its own case here:
 * `next` was printed and never compared, and the `latest` comparison that did run was reading
 * `undefined` on both sides because npm 12 wraps `view --json` output in an array.
 *
 * Every case drives an **injected reader**. Nothing here reaches the network, so a red is a fact
 * about the rule rather than about the registry's mood.
 */

const PUBLISHED = "0.2.0-next.53";
const STALE = "0.2.0-next.52";
const LATEST = "0.2.0-next.19";

/** The twelve-package shape of the run this exists because of. */
const TWELVE = [
  "@aldus-runtime/artifact-registry",
  "@aldus-runtime/cli",
  "@aldus-runtime/core",
  "@aldus-runtime/file-store",
  "@aldus-runtime/gate-engine",
  "@aldus-runtime/mcp",
  "@aldus-runtime/regression",
  "@aldus-runtime/release",
  "@aldus-runtime/services",
  "@aldus-runtime/stage-runner",
  "@aldus-runtime/testkit",
  "@aldus-runtime/tts-ledger",
];

const expectedSet = (names: readonly string[] = TWELVE): { name: string; version: string }[] =>
  names.map((name) => ({ name, version: PUBLISHED }));

const beforeAll = (
  names: readonly string[] = TWELVE,
  tags: DistTags = { latest: LATEST, next: STALE },
): Record<string, DistTags | null> => Object.fromEntries(names.map((name) => [name, tags]));

const tagsReading = (name: string, tags: DistTags): Reading => ({ kind: "tags", name, tags });

/** A reader over a fixed table, counting every call so an unbounded loop cannot go unnoticed. */
const readerOver = (
  table: Record<string, Reading>,
  budget = 10_000,
): { read: (name: string) => Reading; calls: () => number } => {
  let calls = 0;
  return {
    read: (name) => {
      calls += 1;
      if (calls > budget) throw new Error(`reader exhausted after ${budget} reads`);
      const reading = table[name];
      if (reading === undefined) throw new Error(`no fake reading for ${name}`);
      return reading;
    },
    calls: () => calls,
  };
};

/** A virtual clock, so a deadline is exercised without waiting for one. */
const virtualClock = (): { now: () => number; sleep: (ms: number) => void } => {
  let t = 0;
  return { now: () => t, sleep: (ms) => void (t += ms) };
};

const run = (input: Parameters<typeof assertDistTags>[0]): ReturnType<typeof assertDistTags> => {
  const clock = virtualClock();
  return assertDistTags({ now: clock.now, sleep: clock.sleep, ...input });
};

// -------------------------------------------------------------------------------------------------
// The reader. Both faults in the shipped false green live here rather than in the comparison.
// -------------------------------------------------------------------------------------------------

describe("readPayload", () => {
  // Measured on both: npm 11.16.0 returns the bare object, npm 12.0.2 wraps it in an array. The
  // publish job runs `npm install -g npm@latest`, so CI has been on the array shape — and
  // `tags?.latest` on an array is `undefined`, which is why `was === now` held for every package.
  const NPM_11 = JSON.stringify({ "dist-tags": { latest: LATEST, next: PUBLISHED }, name: "p" });
  const NPM_12 = JSON.stringify([{ "dist-tags": { latest: LATEST, next: PUBLISHED }, name: "p" }]);

  it("reads npm 11's bare object and npm 12's single-element array identically", () => {
    for (const text of [NPM_11, NPM_12]) {
      expect(readPayload("p", text)).toEqual({
        kind: "tags",
        name: "p",
        tags: { latest: LATEST, next: PUBLISHED },
      });
    }
  });

  it("refuses a shape it cannot read rather than yielding undefined tags", () => {
    const cases = [
      "",
      "not json",
      JSON.stringify([]),
      JSON.stringify([{ name: "p" }, { name: "p" }]),
      JSON.stringify(null),
      JSON.stringify({ "dist-tags": { latest: LATEST } }),
      JSON.stringify({ name: "p", "dist-tags": null }),
      JSON.stringify({ name: "p", "dist-tags": { latest: 19, next: PUBLISHED } }),
    ];
    for (const text of cases) {
      expect(readPayload("p", text).kind, text).toBe("malformed");
    }
  });

  it("refuses a reply that describes a different package", () => {
    const other = JSON.stringify({ name: "other", "dist-tags": { next: PUBLISHED } });
    expect(readPayload("p", other)).toEqual({
      kind: "mismatch",
      detail: "asked for p, the reply describes other",
    });
  });

  it("reads an unset tag as null, never as a match", () => {
    const text = JSON.stringify({ name: "p", "dist-tags": { latest: LATEST } });
    expect(readPayload("p", text)).toEqual({
      kind: "tags",
      name: "p",
      tags: { latest: LATEST, next: null },
    });
  });
});

describe("classifyRun", () => {
  it("distinguishes a package that does not exist from a registry that could not be reached", () => {
    // Measured against npm 11.16.0 and npm 12.0.2: a 404 exits 1 and puts `E404` in both streams.
    const notFound = {
      status: 1,
      stdout: JSON.stringify({ error: { code: "E404", summary: "Not Found" } }),
      stderr: "npm error code E404\nnpm error 404 Not Found",
    };
    expect(classifyRun("p", notFound)).toEqual({ kind: "absent" });

    const offline = {
      status: 1,
      stdout: "",
      stderr: "npm error code ENOTFOUND\nnpm error network",
    };
    const reading = classifyRun("p", offline);
    expect(reading.kind).toBe("error");
    expect(reading.kind === "error" && reading.detail).toContain("ENOTFOUND");
  });

  it("never reads a non-zero exit as an absence by default", () => {
    expect(classifyRun("p", { status: 137, stdout: "", stderr: "" }).kind).toBe("error");
  });
});

describe("npmReader", () => {
  // Trusting npm's HTTP cache is the exact failure this check exists to catch: a cached document
  // is the stale answer, and it arrives looking identical to a fresh one.
  it("asks for a fresh, self-identifying read on every call", () => {
    const seen: string[][] = [];
    const reader = npmReader((args) => {
      seen.push(args);
      return { status: 0, stdout: JSON.stringify({ name: "p", "dist-tags": { next: PUBLISHED } }) };
    });
    reader("p");
    reader("p");
    expect(seen).toEqual([npmViewArgs("p"), npmViewArgs("p")]);
    for (const args of seen) {
      expect(args).toContain("--prefer-online");
      expect(args).toContain("name");
    }
  });
});

// -------------------------------------------------------------------------------------------------
// The rule.
// -------------------------------------------------------------------------------------------------

describe("evaluatePackage", () => {
  const base = { name: "p", expectedVersion: PUBLISHED, allowLatestMove: false };

  it("passes only when latest is unchanged and next is exactly the intended version", () => {
    const verdict = evaluatePackage({
      ...base,
      before: { latest: LATEST, next: STALE },
      reading: tagsReading("p", { latest: LATEST, next: PUBLISHED }),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it("names the tag, the expected value and the observed value for a stale next", () => {
    const verdict = evaluatePackage({
      ...base,
      before: { latest: LATEST, next: STALE },
      reading: tagsReading("p", { latest: LATEST, next: STALE }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      {
        tag: "next",
        expected: PUBLISHED,
        observed: STALE,
        why: "`next` is not the version this publish intended",
        retriable: true,
      },
    ]);
  });

  it("treats a moved latest as permanent and a stale next as worth re-reading", () => {
    const moved = evaluatePackage({
      ...base,
      before: { latest: LATEST, next: STALE },
      reading: tagsReading("p", { latest: PUBLISHED, next: PUBLISHED }),
    });
    expect(moved.ok).toBe(false);
    expect(moved.retriable).toBe(false);
    expect(moved.problems[0]?.tag).toBe("latest");

    const stale = evaluatePackage({
      ...base,
      before: { latest: LATEST, next: STALE },
      reading: tagsReading("p", { latest: LATEST, next: STALE }),
    });
    expect(stale.retriable).toBe(true);
  });

  it("fails an undeclared latest created by a first publish, the ADR-0023 bootstrap case", () => {
    // `--tag next` does not keep a first publish off `latest`: npm assigns it because a package
    // must have one. A rule that skips the comparison whenever either side is absent permits
    // exactly the deviation ADR-0023 decision 4 exists to catch.
    const verdict = evaluatePackage({
      ...base,
      before: null,
      reading: tagsReading("p", { latest: PUBLISHED, next: PUBLISHED }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      {
        tag: "latest",
        expected: "(none)",
        observed: PUBLISHED,
        why: "latest was created by this publish (first publish of this package)",
        retriable: false,
      },
    ]);
  });

  it("still asserts next when a latest move is declared", () => {
    const verdict = evaluatePackage({
      ...base,
      allowLatestMove: true,
      before: null,
      reading: tagsReading("p", { latest: PUBLISHED, next: STALE }),
    });
    expect(verdict.declared).toEqual(["latest (none) -> 0.2.0-next.53 (declared)"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.map((problem) => problem.tag)).toEqual(["next"]);
  });

  it("reads a missing next as a failure, never as nothing to compare", () => {
    const verdict = evaluatePackage({
      ...base,
      before: { latest: LATEST, next: null },
      reading: tagsReading("p", { latest: LATEST, next: null }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]?.why).toBe("no `next` tag on this package");
    expect(verdict.problems[0]?.observed).toBe("(none)");
  });

  it("fails closed on a malformed, mismatched, absent or unreadable answer", () => {
    const readings: Reading[] = [
      { kind: "malformed", detail: "stdout is not JSON" },
      { kind: "mismatch", detail: "asked for p, the reply describes q" },
      { kind: "absent" },
      { kind: "error", detail: "npm view exited 1: ENOTFOUND" },
    ];
    for (const reading of readings) {
      const verdict = evaluatePackage({
        ...base,
        before: { latest: LATEST, next: STALE },
        reading,
      });
      expect(verdict.ok, reading.kind).toBe(false);
    }
  });

  it("re-reads a network error but never a shape fault", () => {
    const transient = evaluatePackage({
      ...base,
      before: null,
      reading: { kind: "error", detail: "ENOTFOUND" },
    });
    expect(transient.retriable).toBe(true);

    const shape = evaluatePackage({
      ...base,
      before: null,
      reading: { kind: "malformed", detail: "stdout is not JSON" },
    });
    expect(shape.retriable).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// The whole assertion, including the run it exists because of.
// -------------------------------------------------------------------------------------------------

describe("assertDistTags", () => {
  it("passes when every one of the twelve carries the intended next and an unmoved latest", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [name, tagsReading(name, { latest: LATEST, next: PUBLISHED })]),
    );
    const reader = readerOver(table);
    const result = await run({ expected: expectedSet(), before: beforeAll(), read: reader.read });
    expect(result.ok).toBe(true);
    expect(result.rounds).toBe(1);
    expect(reader.calls()).toBe(12);
  });

  // The run itself. Ten packages at .53, `@aldus-runtime/testkit` and `@aldus-runtime/tts-ledger`
  // at .52, `latest` unmoved on all twelve — the exact state the old check reported as green.
  it("refuses run 33470723600's state instead of reporting it green", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [
        name,
        tagsReading(name, {
          latest: LATEST,
          next:
            name === "@aldus-runtime/testkit" || name === "@aldus-runtime/tts-ledger"
              ? STALE
              : PUBLISHED,
        }),
      ]),
    );
    const result = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: readerOver(table).read,
      deadlineMs: 30_000,
      intervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.problems).toEqual([
      `@aldus-runtime/testkit tag=next expected=${PUBLISHED} observed=${STALE} — \`next\` is not the version this publish intended`,
      `@aldus-runtime/tts-ledger tag=next expected=${PUBLISHED} observed=${STALE} — \`next\` is not the version this publish intended`,
    ]);
  });

  it("accepts a registry that is merely late, and re-reads only what has not converged", async () => {
    const lagging = "@aldus-runtime/tts-ledger";
    let laggingReads = 0;
    const read = (name: string): Reading => {
      if (name !== lagging) return tagsReading(name, { latest: LATEST, next: PUBLISHED });
      laggingReads += 1;
      return tagsReading(name, { latest: LATEST, next: laggingReads < 3 ? STALE : PUBLISHED });
    };
    const result = await run({ expected: expectedSet(), before: beforeAll(), read });
    expect(result.ok).toBe(true);
    expect(result.rounds).toBe(3);
    // Eleven converged packages are read once; only the lagging one is asked again.
    expect(laggingReads).toBe(3);
  });

  it("exhausts the deadline on permanent staleness rather than retrying forever", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [name, tagsReading(name, { latest: LATEST, next: STALE })]),
    );
    // The budget is the unbounded-retry tripwire: a loop without its round cap would exhaust the
    // reader and fail with "reader exhausted" instead of the deadline diagnostic below.
    const reader = readerOver(table, 12 + 6 * 11);
    const result = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: reader.read,
      deadlineMs: 30_000,
      intervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.rounds).toBe(6);
    expect(result.problems).toHaveLength(12);
  });

  it("stops at a moved latest rather than spending the whole deadline on it", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [
        name,
        tagsReading(name, {
          latest: name === "@aldus-runtime/core" ? "9.9.9" : LATEST,
          next: PUBLISHED,
        }),
      ]),
    );
    const reader = readerOver(table);
    const result = await run({ expected: expectedSet(), before: beforeAll(), read: reader.read });
    expect(result.ok).toBe(false);
    expect(result.rounds).toBe(1);
    expect(reader.calls()).toBe(12);
    expect(result.problems).toEqual([
      `@aldus-runtime/core tag=latest expected=${LATEST} observed=9.9.9 — latest moved, and a release to \`next\` must not change the default install`,
    ]);
  });

  it("fails on a next that is neither stale nor intended", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [
        name,
        tagsReading(name, {
          latest: LATEST,
          next: name === "@aldus-runtime/mcp" ? "0.2.0-next.99" : PUBLISHED,
        }),
      ]),
    );
    const result = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: readerOver(table).read,
      deadlineMs: 10_000,
      intervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      `@aldus-runtime/mcp tag=next expected=${PUBLISHED} observed=0.2.0-next.99 — \`next\` is not the version this publish intended`,
    ]);
  });

  it("fails immediately on a malformed answer, which no re-read can repair", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [
        name,
        name === "@aldus-runtime/cli"
          ? ({ kind: "malformed", detail: "stdout is not JSON" } satisfies Reading)
          : tagsReading(name, { latest: LATEST, next: PUBLISHED }),
      ]),
    );
    const reader = readerOver(table);
    const result = await run({ expected: expectedSet(), before: beforeAll(), read: reader.read });
    expect(result.ok).toBe(false);
    expect(result.rounds).toBe(1);
    expect(reader.calls()).toBe(12);
    expect(result.problems).toEqual([
      "@aldus-runtime/cli tag=* expected=next=0.2.0-next.53 observed=(malformed) — stdout is not JSON",
    ]);
  });

  it("re-reads a command failure and passes once it clears", async () => {
    let attempts = 0;
    const read = (name: string): Reading => {
      if (name !== "@aldus-runtime/core") {
        return tagsReading(name, { latest: LATEST, next: PUBLISHED });
      }
      attempts += 1;
      if (attempts === 1) return { kind: "error", detail: "npm view exited 1: ENOTFOUND" };
      return tagsReading(name, { latest: LATEST, next: PUBLISHED });
    };
    const result = await run({ expected: expectedSet(), before: beforeAll(), read });
    expect(result.ok).toBe(true);
    expect(result.rounds).toBe(2);
  });

  it("fails when a package the publish should have created is not on the registry", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [
        name,
        name === "@aldus-runtime/release"
          ? ({ kind: "absent" } satisfies Reading)
          : tagsReading(name, { latest: LATEST, next: PUBLISHED }),
      ]),
    );
    const result = await run({
      expected: expectedSet(),
      before: { ...beforeAll(), "@aldus-runtime/release": null },
      read: readerOver(table).read,
      deadlineMs: 10_000,
      intervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.split(" ")[1])).toEqual([
      "tag=latest",
      "tag=next",
    ]);
    expect(result.problems[1]).toContain("observed=(package not on the registry)");
  });

  it("refuses a snapshot describing a package the publish set no longer contains", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [name, tagsReading(name, { latest: LATEST, next: PUBLISHED })]),
    );
    const result = await run({
      expected: expectedSet(),
      before: { ...beforeAll(), "@aldus-runtime/retired": { latest: LATEST, next: STALE } },
      read: readerOver(table).read,
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      "@aldus-runtime/retired tag=* expected=(in the publish set) observed=(recorded before the publish only) — " +
        "the snapshot and the publish set describe different releases",
    ]);
  });

  it("refuses an empty publish set rather than passing vacuously", async () => {
    await expect(
      assertDistTags({ expected: [], before: {}, read: () => ({ kind: "absent" }) }),
    ).rejects.toThrow("refusing to pass vacuously");
  });

  it("refuses a non-positive deadline or interval, which would make the bound meaningless", async () => {
    for (const bounds of [{ deadlineMs: 0 }, { intervalMs: 0 }, { intervalMs: -1 }]) {
      await expect(
        assertDistTags({
          expected: expectedSet(["@aldus-runtime/core"]),
          before: beforeAll(["@aldus-runtime/core"]),
          read: () => tagsReading("@aldus-runtime/core", { latest: LATEST, next: PUBLISHED }),
          ...bounds,
        }),
      ).rejects.toThrow("must be positive");
    }
  });

  it("is idempotent: a stable registry gives the same verdict and the same round count", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [name, tagsReading(name, { latest: LATEST, next: PUBLISHED })]),
    );
    const once = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: readerOver(table).read,
    });
    const twice = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: readerOver(table).read,
    });
    expect(twice.ok).toBe(once.ok);
    expect(twice.rounds).toBe(once.rounds);
    expect(twice.problems).toEqual(once.problems);
  });

  it("is idempotent on a failure too: repeating it does not launder a stale next into a pass", async () => {
    const table = Object.fromEntries(
      TWELVE.map((name) => [name, tagsReading(name, { latest: LATEST, next: STALE })]),
    );
    const bounds = { deadlineMs: 10_000, intervalMs: 5_000 };
    for (const _ of [1, 2, 3]) {
      const result = await run({
        expected: expectedSet(),
        before: beforeAll(),
        read: readerOver(table).read,
        ...bounds,
      });
      expect(result.ok).toBe(false);
      expect(result.problems).toHaveLength(12);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Source freshness. The intended version has to come from the manifests as they are now.
// -------------------------------------------------------------------------------------------------

describe("the intended version comes from this tree", () => {
  it("matches every published manifest on disk, read independently of publish-set.mjs", () => {
    const onDisk = readdirSync(join(repoRoot, "packages"))
      .map((entry) => join(repoRoot, "packages", entry, "package.json"))
      .map((path) => JSON.parse(readFileSync(path, "utf8")) as { name: string; version: string })
      .filter((manifest) => manifest.name !== "@aldus-runtime/e2e")
      .sort((a, b) => a.name.localeCompare(b.name));

    const fromScript = publishSet().map((pkg) => ({
      name: pkg.name,
      version: pkg.manifest.version,
    }));

    expect(fromScript).toEqual(onDisk.map(({ name, version }) => ({ name, version })));
    // A hard-coded version list would survive a bump; this is what makes it not.
    expect(new Set(fromScript.map((entry) => entry.version)).size).toBe(1);
  });

  it("states its own bounds rather than leaving them to a caller that may not pass any", () => {
    expect(DEFAULT_DEADLINE_MS).toBeGreaterThan(0);
    expect(DEFAULT_INTERVAL_MS).toBeGreaterThan(0);
    expect(DEFAULT_DEADLINE_MS / DEFAULT_INTERVAL_MS).toBeGreaterThanOrEqual(2);
  });
});
