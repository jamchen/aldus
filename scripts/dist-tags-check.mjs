/**
 * The post-publish dist-tag rule, as functions a test can drive (ADR-0023 decision 4).
 *
 * ## The false green this replaces
 *
 * Release run 33470723600 published all twelve packages as `0.2.0-next.53` and the immediately
 * following `Assert dist-tags after publishing` step went **green** while printing
 * `next: 0.2.0-next.52` for `@aldus-runtime/testkit` and `@aldus-runtime/tts-ledger`. Two faults,
 * either of which alone is enough:
 *
 * 1. **`next` was printed and never asserted.** The old `assert` compared `latest` only. A release
 *    whose whole purpose is to move `next` never checked that `next` moved — so a package that
 *    silently failed to publish, or that the registry had not yet caught up on, was reported as a
 *    successful release. Printing a value is not checking it.
 *
 * 2. **The `latest` comparison it *did* make was vacuous under CI's npm.** The publish job runs
 *    `npm install -g npm@latest`, and measured on both:
 *
 *    | npm      | `view X dist-tags --json`        |
 *    | -------- | -------------------------------- |
 *    | 11.16.0  | `{"latest":…,"next":…}`          |
 *    | 12.0.2   | `[{"latest":…,"next":…}]`        |
 *
 *    On an **array**, `tags?.latest` is `undefined`. Both sides of `was === now` were `undefined`,
 *    so the comparison held for every package regardless of what the registry said. The run's own
 *    log shows it: every line printed `[{…}]`, brackets and all, under `latest unchanged for every
 *    package.` A check comparing two `undefined`s cannot fail, and this one had not been able to
 *    fail since npm 12 reached the runner.
 *
 * Both are the third category in CLAUDE.md — a non-answer recorded as an answer — arriving through
 * the reader rather than through the reading. So the reader here **refuses a shape it does not
 * recognise** instead of yielding `undefined`, and `absent` is a state distinct from `error`.
 *
 * ## What is asserted, for every package in the publish set
 *
 * - `latest` is **exactly** the value recorded before the publish, unless the move was declared;
 * - `next` is **exactly** the version this tree intended to publish for that package.
 *
 * A missing, stale, malformed, wrong-package or mixed-version `next` never produces green.
 *
 * ## Eventual consistency
 *
 * The registry may serve a stale `next` for seconds after a successful publish — which is what
 * 33470723600 actually caught, and would have reported as a failure at the moment it ran. So a
 * package whose `next` has not converged, whose read failed transiently, or which is not visible
 * yet is **re-read** on a bounded schedule with a deadline, and every read is fresh
 * (`--prefer-online`). Permanent staleness, a network error, a shape fault or incomplete evidence
 * exhausts the deadline and fails closed with exact diagnostics.
 *
 * Nothing here infers success from the publish command. The registry is asked.
 */

/** The two tags this repository asserts. `latest` must not move; `next` must converge. */
export const ASSERTED_TAGS = Object.freeze(["latest", "next"]);

/** Snapshot file format. Bumped if the shape changes, so a stale file refuses rather than misreads. */
export const SNAPSHOT_SCHEMA = 1;

/** How long convergence is waited for, in total. */
export const DEFAULT_DEADLINE_MS = 120_000;

/** How long between re-reads of the packages that have not converged. */
export const DEFAULT_INTERVAL_MS = 5_000;

/**
 * The argv for one read.
 *
 * `name` is requested alongside `dist-tags` so the answer identifies the package it describes —
 * a reply cannot be attributed to a package it does not name. `--prefer-online` revalidates
 * rather than trusting npm's cache: a cached document is exactly the stale answer this check
 * exists to catch, and it would arrive looking identical to a fresh one.
 */
export function npmViewArgs(name) {
  return ["view", name, "dist-tags", "name", "--json", "--prefer-online"];
}

/** Fold npm's two documented `--json` envelopes into one, or say why it could not. */
function unwrapDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problem: `stdout is not JSON (${error instanceof Error ? error.message : error})` };
  }
  // npm 12 wraps every `view` result in an array; npm 11 does not. Any other cardinality is a
  // question about more than one package and cannot answer this one.
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) return { problem: `npm returned ${parsed.length} documents, want 1` };
    return { document: parsed[0] };
  }
  return { document: parsed };
}

/**
 * Turn one `npm view … --json` payload into a reading, or into a refusal naming the defect.
 *
 * Returns one of:
 * - `{ kind: "tags", name, tags: { latest, next } }` — values are `null` when the tag is unset;
 * - `{ kind: "malformed", detail }` — a shape this cannot read, which is never a pass;
 * - `{ kind: "mismatch", detail }` — the reply describes a different package.
 */
export function readPayload(requested, text) {
  const { document, problem } = unwrapDocument(text);
  if (problem !== undefined) return { kind: "malformed", detail: problem };
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { kind: "malformed", detail: `expected an object, got ${JSON.stringify(document)}` };
  }

  const name = document["name"];
  if (typeof name !== "string" || name.length === 0) {
    return {
      kind: "malformed",
      detail: "the reply carries no `name`, so it identifies no package",
    };
  }
  if (name !== requested) {
    return { kind: "mismatch", detail: `asked for ${requested}, the reply describes ${name}` };
  }

  const raw = document["dist-tags"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "malformed",
      detail: `\`dist-tags\` is ${JSON.stringify(raw)}, expected an object`,
    };
  }

  const tags = {};
  for (const tag of ASSERTED_TAGS) {
    const value = raw[tag];
    if (value === undefined) {
      tags[tag] = null;
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      return {
        kind: "malformed",
        detail: `\`${tag}\` is ${JSON.stringify(value)}, expected a version string`,
      };
    }
    tags[tag] = value;
  }
  return { kind: "tags", name, tags };
}

/**
 * Classify one completed `npm view`.
 *
 * `absent` is a state of its own: a package the registry has never heard of is a different fact
 * from a registry that could not be reached, and folding the two is how a network failure passes
 * for "not published yet" and then for "nothing moved".
 */
export function classifyRun(requested, run) {
  if (run.status === 0) return readPayload(requested, run.stdout ?? "");
  const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (/\bE404\b/.test(combined)) return { kind: "absent" };
  const detail = combined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join(" | ");
  return { kind: "error", detail: `npm view exited ${run.status}: ${detail || "(no output)"}` };
}

/** A reader backed by a real `npm view`. `run(args) -> { status, stdout, stderr }` is injectable. */
export function npmReader(run) {
  return (name) => classifyRun(name, run(npmViewArgs(name)));
}

/** `null` when the package had no tags before the publish, else its recorded value for `tag`. */
function recorded(before, tag) {
  if (before === null || before === undefined) return null;
  const value = before[tag];
  return typeof value === "string" ? value : null;
}

const shown = (value) => (value === null ? "(none)" : value);

/**
 * Judge one package against both invariants.
 *
 * `retriable` says only whether *re-reading* could change the answer — eventual consistency and a
 * transient network fault can, a moved `latest` and a malformed reply cannot. It is never a reason
 * to pass.
 */
export function evaluatePackage({ name, expectedVersion, before, reading, allowLatestMove }) {
  const problems = [];
  const declared = [];

  if (reading.kind === "tags") {
    const wasLatest = recorded(before, "latest");
    const nowLatest = reading.tags.latest;
    if (nowLatest !== wasLatest) {
      const why =
        wasLatest === null
          ? "latest was created by this publish (first publish of this package)"
          : "latest moved, and a release to `next` must not change the default install";
      if (allowLatestMove)
        declared.push(`latest ${shown(wasLatest)} -> ${shown(nowLatest)} (declared)`);
      else
        problems.push({
          tag: "latest",
          expected: shown(wasLatest),
          observed: shown(nowLatest),
          why,
          retriable: false,
        });
    }

    const nowNext = reading.tags.next;
    if (nowNext !== expectedVersion) {
      problems.push({
        tag: "next",
        expected: expectedVersion,
        observed: shown(nowNext),
        why:
          nowNext === null
            ? "no `next` tag on this package"
            : "`next` is not the version this publish intended",
        retriable: true,
      });
    }
  } else if (reading.kind === "absent") {
    for (const tag of ASSERTED_TAGS) {
      problems.push({
        tag,
        expected: tag === "next" ? expectedVersion : shown(recorded(before, tag)),
        observed: "(package not on the registry)",
        why: "the registry has no such package after a publish that was supposed to create it",
        retriable: true,
      });
    }
  } else {
    problems.push({
      tag: "*",
      expected: `next=${expectedVersion}`,
      observed: `(${reading.kind})`,
      why: reading.detail,
      // A network fault can heal; a shape fault and a wrong-package reply are deterministic.
      retriable: reading.kind === "error",
    });
  }

  return {
    name,
    ok: problems.length === 0,
    retriable: problems.length > 0 && problems.every((problem) => problem.retriable),
    problems,
    declared,
    reading,
  };
}

/** One diagnostic line: package, tag, expected, observed, and why — nothing inferred. */
export function formatProblem(name, problem) {
  return `${name} tag=${problem.tag} expected=${problem.expected} observed=${problem.observed} — ${problem.why}`;
}

/**
 * Read, judge, and re-read what has not converged, until every package settles or the deadline
 * runs out.
 *
 * Bounded twice over, because a retry loop that can outlive its budget is a release job that hangs
 * instead of failing: a round count derived from the deadline *and* a clock check. Neither alone —
 * an injected clock that does not advance would defeat the second, and a zero interval the first.
 */
export async function assertDistTags({
  expected,
  before,
  read,
  allowLatestMove = false,
  deadlineMs = DEFAULT_DEADLINE_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error("assertDistTags: no packages to assert; refusing to pass vacuously.");
  }
  if (!(intervalMs > 0) || !(deadlineMs > 0)) {
    throw new Error(
      `assertDistTags: deadlineMs and intervalMs must be positive; got ${deadlineMs}/${intervalMs}.`,
    );
  }

  // A package recorded before the publish that is no longer in the set means the two sides are
  // describing different releases, and every per-package verdict below would be about the wrong
  // set. Structural, so it is decided once rather than retried.
  const names = new Set(expected.map((entry) => entry.name));
  const strays = Object.keys(before ?? {}).filter((name) => !names.has(name));

  const maxRounds = Math.max(1, Math.ceil(deadlineMs / intervalMs));
  const started = now();
  const readings = new Map();
  let pending = expected.map((entry) => entry.name);
  let rounds = 0;
  let results = [];

  for (;;) {
    rounds += 1;
    for (const name of pending) readings.set(name, await read(name));

    results = expected.map((entry) =>
      evaluatePackage({
        name: entry.name,
        expectedVersion: entry.version,
        before: (before ?? {})[entry.name] ?? null,
        reading: readings.get(entry.name),
        allowLatestMove,
      }),
    );

    const failed = results.filter((result) => !result.ok);
    if (failed.length === 0) break;
    // A failure no re-read can change is answered now rather than after the whole deadline.
    if (failed.some((result) => !result.retriable)) break;
    if (rounds >= maxRounds) break;
    if (now() - started >= deadlineMs) break;

    pending = failed.map((result) => result.name);
    await sleep(intervalMs);
  }

  const problems = results.flatMap((result) =>
    result.problems.map((problem) => formatProblem(result.name, problem)),
  );
  for (const stray of strays) {
    problems.push(
      `${stray} tag=* expected=(in the publish set) observed=(recorded before the publish only) — ` +
        "the snapshot and the publish set describe different releases",
    );
  }

  return {
    ok: problems.length === 0,
    rounds,
    exhausted: rounds >= maxRounds && problems.length > 0,
    results,
    problems,
    elapsedMs: now() - started,
  };
}
