/**
 * Deterministic time and identity for tests.
 *
 * Architecture contract §3.4 makes files and Runtime state authoritative and session memory
 * not. A test that asserts against durable state therefore has to assert against exact bytes —
 * and it cannot, if every run stamps a different timestamp and mints a different ULID. Every
 * such assertion degrades into a wildcard match, and a wildcard match stops catching the
 * regressions it was written for.
 *
 * So this module supplies a frozen clock and a seeded, non-cryptographic byte source. The same
 * seed produces the same sequence on every run and every platform.
 *
 * Nothing here is for production. The byte source is a 64-bit SplitMix generator chosen for
 * reproducibility, and it must never back a real {@link IdFactory}.
 */

import { createIdFactory, type IdFactory, type IdFactoryOptions } from "@aldus-runtime/core";

/* -------------------------------------------------------------------------------------------
 * Clock
 * ---------------------------------------------------------------------------------------- */

/**
 * Default instant for a test clock: `2026-01-01T00:00:00.000Z`.
 *
 * Deliberately round and obviously synthetic. A fixture timestamp that looks like a plausible
 * production time invites someone to read meaning into it; this one cannot be mistaken for a
 * real recording.
 */
export const TEST_EPOCH_ISO = "2026-01-01T00:00:00.000Z";

/** @see TEST_EPOCH_ISO */
export const TEST_EPOCH_MS = Date.parse(TEST_EPOCH_ISO);

/** A clock whose time only changes when a test says so. */
export interface TestClock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** The current instant as an ISO-8601 string with an explicit `Z` offset. */
  nowIso(): string;
  /** Move the clock forward. Negative values are rejected: a rewinding clock is a test bug. */
  advance(milliseconds: number): void;
  /** Jump to an absolute instant, given as an ISO-8601 string. */
  set(iso: string): void;
}

/**
 * Create a clock frozen at `startIso`, advancing only when a test advances it.
 *
 * Contract §20 requires the production trace to answer "when"; the timestamps a builder stamps
 * come from here so that a test can state exactly what that answer should be.
 *
 * @param startIso Initial instant. Defaults to {@link TEST_EPOCH_ISO}.
 */
export function createTestClock(startIso: string = TEST_EPOCH_ISO): TestClock {
  let current = parseIso(startIso);

  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),
    advance(milliseconds: number): void {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError(
          `Test clock cannot advance by ${milliseconds}: a rewinding or non-finite clock hides ` +
            "ordering bugs rather than exposing them. Use set() to jump backwards deliberately.",
        );
      }
      current += milliseconds;
    },
    set(iso: string): void {
      current = parseIso(iso);
    },
  };
}

function parseIso(iso: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new RangeError(`Not a parseable ISO-8601 instant: "${iso}".`);
  }
  return parsed;
}

/* -------------------------------------------------------------------------------------------
 * Deterministic byte source
 * ---------------------------------------------------------------------------------------- */

/** Default seed for {@link createSeededBytes}. Arbitrary, fixed, and documented so it is stable. */
export const DEFAULT_TEST_SEED = 0x5eed_1234;

/**
 * A seeded pseudo-random byte source.
 *
 * SplitMix64, implemented inline with `BigInt` so the arithmetic is exact and identical on
 * every platform — a generator built on `Math.imul` and 32-bit truncation would be faster but
 * would risk differing across engines, which is precisely the property being bought here.
 *
 * **Not cryptographic.** It exists so `createTestIdFactory` mints a reproducible ID sequence.
 */
export function createSeededBytes(seed: number = DEFAULT_TEST_SEED): (n: number) => Uint8Array {
  const MASK = (1n << 64n) - 1n;
  const GOLDEN = 0x9e37_79b9_7f4a_7c15n;
  let state = BigInt(Math.trunc(seed)) & MASK;

  function next(): bigint {
    state = (state + GOLDEN) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  }

  return (n: number): Uint8Array => {
    const bytes = new Uint8Array(n);
    let available = 0n;
    let remaining = 0;
    for (let index = 0; index < n; index += 1) {
      if (remaining === 0) {
        available = next();
        remaining = 8;
      }
      bytes[index] = Number(available & 0xffn);
      available >>= 8n;
      remaining -= 1;
    }
    return bytes;
  };
}

/* -------------------------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------------------------- */

/** Options for {@link createTestIdFactory}. */
export interface TestIdFactoryOptions {
  /** Clock the factory reads. Defaults to a fresh {@link createTestClock}. */
  clock?: TestClock;
  /** Seed for the byte source. Defaults to {@link DEFAULT_TEST_SEED}. */
  seed?: number;
}

/**
 * A Core {@link IdFactory} wired to a frozen clock and a seeded byte source.
 *
 * Two factories built with the same clock instant and seed mint the identical sequence, which
 * is what lets a fixture assert an exact `runId` instead of a pattern.
 */
export function createTestIdFactory(options: TestIdFactoryOptions = {}): IdFactory {
  const clock = options.clock ?? createTestClock();
  const factoryOptions: IdFactoryOptions = {
    now: () => clock.now(),
    randomBytes: createSeededBytes(options.seed ?? DEFAULT_TEST_SEED),
  };
  return createIdFactory(factoryOptions);
}

/* -------------------------------------------------------------------------------------------
 * Context
 * ---------------------------------------------------------------------------------------- */

/**
 * Clock and identity together, so a builder call site passes one object rather than two.
 *
 * Every builder in this package accepts a context. Sharing one across a set of builder calls is
 * what makes a composed record — a Run with its Episode, a Stage Execution with its attempts —
 * internally consistent and reproducible as a whole.
 */
export interface TestContext {
  /** The frozen clock. */
  clock: TestClock;
  /** Identity minted against that clock. */
  ids: IdFactory;
}

/** Options for {@link createTestContext}. */
export interface TestContextOptions {
  /** Initial instant. Defaults to {@link TEST_EPOCH_ISO}. */
  startIso?: string;
  /** Seed for the byte source. Defaults to {@link DEFAULT_TEST_SEED}. */
  seed?: number;
}

/** Create a {@link TestContext} with a frozen clock and a seeded ID factory. */
export function createTestContext(options: TestContextOptions = {}): TestContext {
  const clock = createTestClock(options.startIso ?? TEST_EPOCH_ISO);
  const idOptions: TestIdFactoryOptions =
    options.seed === undefined ? { clock } : { clock, seed: options.seed };
  return { clock, ids: createTestIdFactory(idOptions) };
}

/* -------------------------------------------------------------------------------------------
 * Digests
 * ---------------------------------------------------------------------------------------- */

/**
 * Derive a stable, well-formed SHA-256 digest from a seed string.
 *
 * Contract §8.1 makes hashes load-bearing identity, and Core requires lowercase hexadecimal, so
 * a fixture cannot use a placeholder like `"abc"`. This produces a value that satisfies the
 * constraint and is stable across runs, without pulling in a real hash implementation whose
 * output would be opaque in a fixture file.
 *
 * **Not a real SHA-256** of anything. It is a deterministic 64-character hex string derived from
 * the seed, suitable only as test data.
 */
export function testDigest(seed: string): string {
  const bytes = createSeededBytes(stringSeed(seed))(32);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** FNV-1a over a string, reduced to a 32-bit seed for {@link createSeededBytes}. */
function stringSeed(value: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash;
}
