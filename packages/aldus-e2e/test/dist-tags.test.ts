import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_CONVERGENCE_MS,
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
 * The second subject is the **red that meant two things** (#266). Runs 33583936736 and 33593065914
 * each published all twelve packages; each time the assertion read `@aldus-runtime/testkit` at the
 * previous `next` for 120 s and failed with the same line a partial publish would produce. The
 * registry converged about five minutes later both times. The cases under "the third state" pin
 * the split: a `next` that is exactly the pre-publish value on an otherwise sound reading gets a
 * longer bound and then a `declined` verdict, never a pass and never a failure; anything else
 * wrong is still a failure, decided as soon as it is seen.
 *
 * Every case drives an **injected reader**, except the last block, which drives the real
 * `dist-tags.mjs` process against a fake `npm` on `PATH` — the exit codes live in that file, and a
 * test of the rule alone cannot see them. Nothing here reaches the network, so a red is a fact
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
    expect(verdict.lagging).toBe(true);
    expect(verdict.problems).toEqual([
      {
        tag: "next",
        expected: PUBLISHED,
        observed: STALE,
        why: "`next` is still the value recorded before the publish (not yet converged, or never published)",
        retriable: true,
        lagging: true,
      },
    ]);
  });

  it("calls a next that is neither intended nor pre-publish wrong, not lagging, and not retriable", () => {
    // A registry that has not caught up serves the old document. It does not serve a third one.
    const verdict = evaluatePackage({
      ...base,
      before: { latest: LATEST, next: STALE },
      reading: tagsReading("p", { latest: LATEST, next: "0.2.0-next.99" }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.lagging).toBe(false);
    expect(verdict.retriable).toBe(false);
    expect(verdict.problems[0]?.why).toBe("`next` is not the version this publish intended");
  });

  it("does not call a pre-publish next lagging when latest moved on the same package", () => {
    const verdict = evaluatePackage({
      ...base,
      before: { latest: LATEST, next: STALE },
      reading: tagsReading("p", { latest: "9.9.9", next: STALE }),
    });
    expect(verdict.lagging).toBe(false);
    expect(verdict.retriable).toBe(false);
    expect(verdict.problems.map((problem) => problem.lagging)).toEqual([false, false]);
  });

  it("does not call a first publish with no next lagging: there is no pre-publish value to match", () => {
    const verdict = evaluatePackage({
      ...base,
      before: null,
      reading: tagsReading("p", { latest: null, next: null }),
    });
    expect(verdict.lagging).toBe(false);
    expect(verdict.retriable).toBe(true);
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
        lagging: false,
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
  //
  // Since #266 this state, held to the bound, is **declined** rather than failed: it is what a
  // registry five minutes behind looks like and also what a partial publish looks like. What the
  // case pins is that it is never green — `ok` is false and both packages are named.
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
      convergenceMs: 30_000,
      intervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("declined");
    expect(result.exhausted).toBe(true);
    expect(result.lagging).toEqual(["@aldus-runtime/testkit", "@aldus-runtime/tts-ledger"]);
    expect(result.problems).toEqual([
      `@aldus-runtime/testkit tag=next expected=${PUBLISHED} observed=${STALE} — \`next\` is still the value recorded before the publish (not yet converged, or never published)`,
      `@aldus-runtime/tts-ledger tag=next expected=${PUBLISHED} observed=${STALE} — \`next\` is still the value recorded before the publish (not yet converged, or never published)`,
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
    // reader and fail with "reader exhausted" instead of the bound diagnostic below. Twelve packages
    // all still at the pre-publish `next` is the lagging shape, so the bound in force is the
    // convergence one.
    const reader = readerOver(table, 12 + 6 * 11);
    const result = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: reader.read,
      deadlineMs: 30_000,
      convergenceMs: 30_000,
      intervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("declined");
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
    const reader = readerOver(table);
    const result = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: reader.read,
      deadlineMs: 10_000,
      intervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("fail");
    // A third value is not a registry catching up, so it is not re-read: decided in one round.
    expect(result.rounds).toBe(1);
    expect(reader.calls()).toBe(12);
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
    for (const bounds of [
      { deadlineMs: 0 },
      { convergenceMs: 0 },
      { intervalMs: 0 },
      { intervalMs: -1 },
    ]) {
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
    const bounds = { deadlineMs: 10_000, convergenceMs: 10_000, intervalMs: 5_000 };
    for (const _ of [1, 2, 3]) {
      const result = await run({
        expected: expectedSet(),
        before: beforeAll(),
        read: readerOver(table).read,
        ...bounds,
      });
      expect(result.ok).toBe(false);
      expect(result.verdict).toBe("declined");
      expect(result.problems).toHaveLength(12);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// The third state (#266). One package exactly one version behind, on a publish that succeeded, is
// not distinguishable from a partial publish by reading the registry — so it is declined, never
// passed and never failed. Everything else wrong is still a failure, and a failure wins.
// -------------------------------------------------------------------------------------------------

describe("assertDistTags: the third state", () => {
  /** Eleven converged, `name` still serving the pre-publish `next`. Runs 33583936736 and 33593065914. */
  const oneBehind = (name: string, overrides: Record<string, Reading> = {}) =>
    Object.fromEntries(
      TWELVE.map((pkg) => [
        pkg,
        overrides[pkg] ??
          tagsReading(pkg, { latest: LATEST, next: pkg === name ? STALE : PUBLISHED }),
      ]),
    );

  it("declines rather than passes or fails when one package is still one behind at the bound", async () => {
    const reader = readerOver(oneBehind("@aldus-runtime/testkit"));
    const result = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: reader.read,
      deadlineMs: 20_000,
      convergenceMs: 60_000,
      intervalMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("declined");
    expect(result.lagging).toEqual(["@aldus-runtime/testkit"]);
    expect(result.exhausted).toBe(true);
    // Held to the convergence bound, not the deadline: 60 s / 5 s = 12 rounds, and only the
    // lagging package is re-read after the first.
    expect(result.rounds).toBe(12);
    expect(reader.calls()).toBe(12 + 11);
    expect(result.problems).toHaveLength(1);
  });

  it("passes when the lagging package converges inside the longer bound", async () => {
    let reads = 0;
    const read = (name: string): Reading => {
      if (name !== "@aldus-runtime/testkit") {
        return tagsReading(name, { latest: LATEST, next: PUBLISHED });
      }
      reads += 1;
      // Converges on the 61st read: 300 s at 5 s intervals — the measured lag, past the old
      // 120 s deadline and inside the new bound.
      return tagsReading(name, { latest: LATEST, next: reads <= 60 ? STALE : PUBLISHED });
    };
    const result = await run({ expected: expectedSet(), before: beforeAll(), read });
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("pass");
    expect(result.rounds).toBe(61);
  });

  it("fails, not declines, when one package is one behind and another is wrong", async () => {
    const reader = readerOver(
      oneBehind("@aldus-runtime/testkit", {
        "@aldus-runtime/mcp": tagsReading("@aldus-runtime/mcp", {
          latest: LATEST,
          next: "0.2.0-next.99",
        }),
      }),
    );
    const result = await run({ expected: expectedSet(), before: beforeAll(), read: reader.read });
    expect(result.verdict).toBe("fail");
    expect(result.ok).toBe(false);
    expect(result.rounds).toBe(1);
    expect(result.problems.map((problem) => problem.split(" ")[0])).toEqual([
      "@aldus-runtime/mcp",
      "@aldus-runtime/testkit",
    ]);
  });

  it("fails, not declines, when one package is one behind and latest moved on another", async () => {
    const reader = readerOver(
      oneBehind("@aldus-runtime/testkit", {
        "@aldus-runtime/core": tagsReading("@aldus-runtime/core", {
          latest: "9.9.9",
          next: PUBLISHED,
        }),
      }),
    );
    const result = await run({ expected: expectedSet(), before: beforeAll(), read: reader.read });
    expect(result.verdict).toBe("fail");
    expect(result.rounds).toBe(1);
    expect(result.problems[0]).toContain("tag=latest");
  });

  it("holds an absent package to the ordinary deadline and fails there, even with a lagging one alongside", async () => {
    // Absence has no measurement behind it. Only the lagging shape earns the longer bound, and
    // while an absence is outstanding the deadline is the bound in force.
    const reader = readerOver(
      oneBehind("@aldus-runtime/testkit", {
        "@aldus-runtime/release": { kind: "absent" } satisfies Reading,
      }),
    );
    const result = await run({
      expected: expectedSet(),
      before: beforeAll(),
      read: reader.read,
      deadlineMs: 20_000,
      convergenceMs: 60_000,
      intervalMs: 5_000,
    });
    expect(result.verdict).toBe("fail");
    expect(result.stop).toBe("exhausted");
    expect(result.exhausted).toBe(true);
    expect(result.rounds).toBe(4);
    expect(
      result.problems.some((problem) => problem.includes("(package not on the registry)")),
    ).toBe(true);
  });

  it("fails, not declines, when the snapshot names a package the publish set does not", async () => {
    // Known before the first read and changed by no re-read, so the loop ends after one round
    // rather than polling the lagging package to the convergence bound (PR #270 review, finding 2).
    const reader = readerOver(oneBehind("@aldus-runtime/testkit"));
    const result = await run({
      expected: expectedSet(),
      before: { ...beforeAll(), "@aldus-runtime/retired": { latest: LATEST, next: STALE } },
      read: reader.read,
      deadlineMs: 10_000,
      convergenceMs: 60_000,
      intervalMs: 5_000,
    });
    expect(result.verdict).toBe("fail");
    expect(result.stop).toBe("structural");
    expect(result.strays).toEqual(["@aldus-runtime/retired"]);
    expect(result.rounds).toBe(1);
    expect(reader.calls()).toBe(12);
    expect(result.problems).toHaveLength(2);
  });

  it("refuses a convergence bound shorter than the deadline", async () => {
    await expect(
      assertDistTags({
        expected: expectedSet(["@aldus-runtime/core"]),
        before: beforeAll(["@aldus-runtime/core"]),
        read: () => tagsReading("@aldus-runtime/core", { latest: LATEST, next: PUBLISHED }),
        deadlineMs: 20_000,
        convergenceMs: 10_000,
      }),
    ).rejects.toThrow("must not be shorter than deadlineMs");
  });
});

// -------------------------------------------------------------------------------------------------
// The process. Exit codes are decided in `dist-tags.mjs`, not in the rule, so the rule's tests
// cannot see a DECLINED folded into a 0 there. A fake `npm` on `PATH` answers `view` from a table.
// -------------------------------------------------------------------------------------------------

describe("dist-tags.mjs assert: exit codes", () => {
  const set = publishSet().map((pkg) => ({ name: pkg.name, version: pkg.manifest.version }));
  const intended = set[0]?.version ?? "";
  const PREVIOUS = "0.0.0-previous";
  const temporaries: string[] = [];
  afterAll(() => {
    for (const path of temporaries) rmSync(path, { recursive: true, force: true });
  });

  /** A `npm` that answers `view <name> …` from a JSON table, in npm 12's array envelope. */
  function fakeNpm(dir: string): void {
    writeFileSync(
      join(dir, "fake-npm.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        "const table = JSON.parse(readFileSync(process.env.FAKE_REGISTRY, 'utf8'));",
        "const [verb, name] = process.argv.slice(2);",
        'if (verb !== "view") { console.error("fake npm: unsupported " + verb); process.exit(9); }',
        "const tags = table[name];",
        'if (tags === undefined) { console.error("npm error code E404\\nnpm error 404 Not Found"); process.exit(1); }',
        'console.log(JSON.stringify([{ name, "dist-tags": tags }]));',
      ].join("\n"),
    );
    writeFileSync(join(dir, "npm"), `#!/bin/sh\nexec node "${join(dir, "fake-npm.mjs")}" "$@"\n`);
    chmodSync(join(dir, "npm"), 0o755);
  }

  /** Milliseconds for one run: the deadline for absence, the longer bound for lag, the interval. */
  interface Bounds {
    deadline: number;
    convergence: number;
    interval: number;
  }
  const TINY: Bounds = { deadline: 60, convergence: 120, interval: 20 };

  /**
   * Run the real script against a registry table. Bounds are tiny because a virtual clock cannot be
   * injected across a process boundary; the interval still leaves room for several rounds. A case
   * about *which* bound ended the loop passes wider ones, so a round of twelve spawned reads cannot
   * by itself outlive the bound the case is not about.
   */
  function assertWith(
    registry: Record<string, Record<string, string>>,
    options: {
      bounds?: Bounds;
      args?: readonly string[];
      alsoBefore?: Record<string, Record<string, string>>;
    } = {},
  ) {
    const bounds = options.bounds ?? TINY;
    const dir = mkdtempSync(join(tmpdir(), "dist-tags-exit-"));
    temporaries.push(dir);
    fakeNpm(dir);
    const registryFile = join(dir, "registry.json");
    writeFileSync(registryFile, JSON.stringify(registry));
    const beforeFile = join(dir, "before.json");
    writeFileSync(
      beforeFile,
      JSON.stringify({
        schema: 1,
        packages: {
          ...Object.fromEntries(set.map(({ name }) => [name, { latest: LATEST, next: PREVIOUS }])),
          ...(options.alsoBefore ?? {}),
        },
      }),
    );
    const result = spawnSync(
      "node",
      [
        join(repoRoot, "scripts", "dist-tags.mjs"),
        "assert",
        beforeFile,
        "--deadline-ms",
        String(bounds.deadline),
        "--convergence-ms",
        String(bounds.convergence),
        "--interval-ms",
        String(bounds.interval),
        ...(options.args ?? []),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          FAKE_REGISTRY: registryFile,
        },
      },
    );
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /** The script's own summary line, so a case can assert on rounds and time rather than infer them. */
  function readSummary(stdout: string): { rounds: number; elapsedMs: number } {
    const match = /Read in (\d+) round\(s\) over (\d+)ms\./.exec(stdout);
    if (match === null) throw new Error(`no summary line in stdout:\n${stdout}`);
    return { rounds: Number(match[1]), elapsedMs: Number(match[2]) };
  }

  /**
   * The pattern `release.yml` greps the script's stderr for before printing its "not yet converged"
   * summary, read out of the workflow file itself. The workflow keys that summary on the exit code
   * *and* this first line, so a declined invocation exiting 2 does not get a summary written for a
   * slow registry; the cases below check the pattern against the script's real output in both
   * directions, so the workflow and the script cannot drift apart unnoticed.
   */
  const workflowDeclinedPattern = (): RegExp => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const match = /grep -q '([^']+)' "\$\{stderr\}"/.exec(workflow);
    if (match === null || match[1] === undefined) {
      throw new Error("release.yml no longer greps the assertion's stderr for its DECLINED line");
    }
    return new RegExp(match[1], "m");
  };

  const converged = (): Record<string, Record<string, string>> =>
    Object.fromEntries(set.map(({ name }) => [name, { latest: LATEST, next: intended }]));

  it("exits 0 when every package converged", () => {
    const run = assertWith(converged());
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("next converged to the intended version");
  });

  it("exits 1 when a package carries a next this publish neither intended nor recorded", () => {
    const registry = converged();
    registry["@aldus-runtime/mcp"] = { latest: LATEST, next: "0.0.0-wrong" };
    const run = assertWith(registry);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dist-tags assertion FAILED");
    expect(run.stderr).not.toContain("DECLINED");
  });

  it("exits 1 when latest moved", () => {
    const registry = converged();
    registry["@aldus-runtime/core"] = { latest: "9.9.9", next: intended };
    const run = assertWith(registry);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("tag=latest");
    expect(run.stderr).not.toContain("DECLINED");
  });

  it("declines with exit 2 when one package is still one behind at the bound", () => {
    const registry = converged();
    registry["@aldus-runtime/testkit"] = { latest: LATEST, next: PREVIOUS };
    const run = assertWith(registry);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("DECLINED:");
    expect(run.stderr).toContain("NOT a gate pass and NOT a gate failure");
    expect(run.stderr).toContain("  @aldus-runtime/testkit\n");
    expect(run.stderr).toContain("npm view @aldus-runtime/testkit dist-tags");
    expect(run.stderr).not.toContain("FAILED");
    expect(run.stdout).not.toContain("converged to the intended version");
    // The workflow's summary branch recognises this, and only this, exit 2.
    expect(run.stderr).toMatch(workflowDeclinedPattern());
  });

  it("does not assert a publish succeeded unless the caller says so with --after-publish", () => {
    // From a laptop the script has no evidence a publish preceded it, and the first version said
    // "reported success for every package" anyway (PR #270 review, finding 3). The fact is the
    // caller's to state: `release.yml` passes the flag because its Publish step runs first.
    const registry = converged();
    registry["@aldus-runtime/testkit"] = { latest: LATEST, next: PREVIOUS };

    const bare = assertWith(registry);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("If this ran after a publish step that succeeded");
    expect(bare.stderr).toContain("did not pass --after-publish");
    expect(bare.stderr).not.toContain("reported success");

    const stated = assertWith(registry, { args: ["--after-publish"] });
    expect(stated.status).toBe(2);
    expect(stated.stderr).toContain("reported success for every package");
    expect(stated.stderr).toContain("caller passed --after-publish");
    expect(stated.stderr).not.toContain("If this ran after");
  });

  it("exits 1, not 2, when one package is one behind and another is wrong", () => {
    const registry = converged();
    registry["@aldus-runtime/testkit"] = { latest: LATEST, next: PREVIOUS };
    registry["@aldus-runtime/mcp"] = { latest: LATEST, next: "0.0.0-wrong" };
    const run = assertWith(registry);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dist-tags assertion FAILED");
    expect(run.stderr).not.toContain("DECLINED");
  });

  it("exits 1 at the deadline, not the convergence bound, when a package is absent and another lags", () => {
    // Absence has no measurement behind it, so it is held to the ordinary deadline even while a
    // lagging package is alongside; the review's hand mutant (ii) — `failed.some(lagging)` — was
    // caught by one unit case only, so the mix is asserted through the real process as well
    // (PR #270 review, finding 5). The convergence bound is wide enough that a round of twelve
    // spawned reads cannot reach it by accident; the deadline is what has to end the loop.
    const registry = converged();
    registry["@aldus-runtime/testkit"] = { latest: LATEST, next: PREVIOUS };
    delete registry["@aldus-runtime/release"];
    const bounds: Bounds = { deadline: 300, convergence: 6_000, interval: 20 };
    const run = assertWith(registry, { bounds });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dist-tags assertion FAILED");
    expect(run.stderr).toContain("(package not on the registry)");
    expect(run.stderr).toContain(`The ${bounds.deadline}ms deadline was exhausted`);
    expect(run.stderr).not.toContain("DECLINED");
    const { elapsedMs } = readSummary(run.stdout);
    expect(elapsedMs).toBeLessThan(bounds.convergence);
  });

  it("exits 1 after one round when the snapshot names a stray package alongside a lagging one", () => {
    // A stray is known before the first read and no re-read can change it; the first version
    // computed it and then polled the lagging package to the full convergence bound before failing
    // — 37 rounds over six seconds in the review's probe, ten minutes in production (PR #270
    // review, finding 2). Its footer also said the deadline was exhausted with a package absent,
    // when nothing was absent (finding 1). The convergence bound here is wide enough that a
    // one-round run cannot reach it by accident, so the round count is what distinguishes the fix.
    const registry = converged();
    registry["@aldus-runtime/testkit"] = { latest: LATEST, next: PREVIOUS };
    const bounds: Bounds = { deadline: 1_000, convergence: 6_000, interval: 20 };
    const run = assertWith(registry, {
      bounds,
      alsoBefore: { "@aldus-runtime/retired": { latest: LATEST, next: PREVIOUS } },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dist-tags assertion FAILED");
    expect(run.stderr).toContain("@aldus-runtime/retired tag=* expected=(in the publish set)");
    expect(run.stderr).toContain("The two sides describe different releases");
    expect(run.stderr).toContain("a lagging package alongside it is not waited for");
    expect(run.stderr).not.toContain("deadline was exhausted");
    expect(run.stderr).not.toContain("absent or unreadable");
    expect(run.stderr).not.toContain("DECLINED");
    const { rounds, elapsedMs } = readSummary(run.stdout);
    expect(rounds).toBe(1);
    expect(elapsedMs).toBeLessThan(bounds.convergence);
  });

  /** Run the script with raw arguments and no fake registry: nothing here should read anything. */
  function invoke(...args: string[]) {
    const result = spawnSync("node", [join(repoRoot, "scripts", "dist-tags.mjs"), ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /** What every declined invocation carries, and what the workflow's converged branch must not see. */
  function expectDeclinedInvocation(run: {
    status: number | null;
    stdout: string;
    stderr: string;
  }) {
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^DECLINED: dist-tags\.mjs /m);
    expect(run.stderr).toContain(
      "This is a declined invocation. It is NOT a gate pass and NOT a gate failure.",
    );
    expect(run.stderr).toContain(
      "usage: node scripts/dist-tags.mjs snapshot <file> | assert <before>",
    );
    expect(run.stderr).toContain(
      "Exit codes: 0 the gate passed, 1 the gate failed, 2 declined (no result).",
    );
    expect(run.stderr).not.toContain("FAILED");
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toMatch(workflowDeclinedPattern());
  }

  it("declines a convergence bound shorter than the deadline before reading anything", () => {
    const run = invoke(
      "assert",
      "/nonexistent/before.json",
      "--deadline-ms",
      "100",
      "--convergence-ms",
      "50",
    );
    expectDeclinedInvocation(run);
    expect(run.stderr).toContain("--convergence-ms 50, shorter than --deadline-ms 100");
  });

  it("spells every other exit 2 the same way: a bad number, a foreign snapshot, no mode, no file", () => {
    // The first version exited 2 from three bare `dist-tags: …` lines of its own alongside the
    // one `DECLINED:` (PR #270 review, finding 4). One spelling, so a reader — and the workflow
    // branch that now reads the first line — can tell a refused invocation from a declined result.
    const dir = mkdtempSync(join(tmpdir(), "dist-tags-refusals-"));
    temporaries.push(dir);
    const foreign = join(dir, "foreign.json");
    writeFileSync(foreign, JSON.stringify({ schema: 99, packages: {} }));
    const notJson = join(dir, "not.json");
    writeFileSync(notJson, "not json");

    const badNumber = invoke("assert", foreign, "--interval-ms", "soon");
    expectDeclinedInvocation(badNumber);
    expect(badNumber.stderr).toContain("--interval-ms soon, which is not a positive number");

    const foreignSchema = invoke("assert", foreign);
    expectDeclinedInvocation(foreignSchema);
    expect(foreignSchema.stderr).toContain("is not a schema-1 snapshot");

    const unreadable = invoke("assert", notJson);
    expectDeclinedInvocation(unreadable);
    expect(unreadable.stderr).toContain("could not read");

    const noMode = invoke();
    expectDeclinedInvocation(noMode);
    expect(noMode.stderr).toContain("was invoked with no mode");

    const unknownMode = invoke("verify", foreign);
    expectDeclinedInvocation(unknownMode);
    expect(unknownMode.stderr).toContain('does not know the mode "verify"');

    const noFile = invoke("assert");
    expectDeclinedInvocation(noFile);
    expect(noFile.stderr).toContain("was invoked with no <before> argument");
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
    // The convergence bound is derived from a measurement — about five minutes, twice (#266) —
    // and must cover it with margin, or the assertion declines on the very lag it was widened for.
    expect(DEFAULT_CONVERGENCE_MS).toBeGreaterThanOrEqual(DEFAULT_DEADLINE_MS);
    expect(DEFAULT_CONVERGENCE_MS).toBeGreaterThanOrEqual(2 * 300_000);
  });
});
