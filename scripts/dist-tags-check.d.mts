/**
 * Types for the post-publish dist-tag rule.
 *
 * Declared rather than suppressed, for the reason `breaking-coverage.d.mts` gives: the alternative
 * is a `@ts-expect-error` on the import, which turns a typed test of a release gate into an
 * untyped one.
 */

/** The two tags asserted around a publish. */
export declare const ASSERTED_TAGS: readonly ["latest", "next"];

/** Snapshot file format version. */
export declare const SNAPSHOT_SCHEMA: number;

/** Total convergence budget, in milliseconds. */
export declare const DEFAULT_DEADLINE_MS: number;

/** Delay between re-reads of the packages that have not converged. */
export declare const DEFAULT_INTERVAL_MS: number;

/** The `latest` and `next` a package carries; `null` when the tag is unset. */
export interface DistTags {
  readonly latest: string | null;
  readonly next: string | null;
}

/** What one read of the registry produced. `absent` is never folded into `error`. */
export type Reading =
  | { readonly kind: "tags"; readonly name: string; readonly tags: DistTags }
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly detail: string }
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "mismatch"; readonly detail: string };

/** One failing invariant, with everything a reader needs and nothing inferred. */
export interface TagProblem {
  readonly tag: string;
  readonly expected: string;
  readonly observed: string;
  readonly why: string;
  /** Whether re-reading could change this answer. Never a reason to pass. */
  readonly retriable: boolean;
}

/** One package's verdict. */
export interface PackageVerdict {
  readonly name: string;
  readonly ok: boolean;
  readonly retriable: boolean;
  readonly problems: readonly TagProblem[];
  readonly declared: readonly string[];
  readonly reading: Reading;
}

/** The argv one read uses, including the flags that make it fresh and self-identifying. */
export declare function npmViewArgs(name: string): string[];

/** Parse one `npm view … --json` payload, or refuse it by name. */
export declare function readPayload(requested: string, text: string): Reading;

/** Classify one completed `npm view` invocation. */
export declare function classifyRun(
  requested: string,
  run: { status: number | null; stdout?: string; stderr?: string },
): Reading;

/** A reader backed by a real `npm view`. */
export declare function npmReader(
  run: (args: string[]) => { status: number | null; stdout?: string; stderr?: string },
): (name: string) => Reading;

/** Judge one package against both invariants. */
export declare function evaluatePackage(input: {
  name: string;
  expectedVersion: string;
  before: DistTags | null;
  reading: Reading;
  allowLatestMove: boolean;
}): PackageVerdict;

/** One diagnostic line. */
export declare function formatProblem(name: string, problem: TagProblem): string;

/** What the whole assertion concluded. */
export interface AssertResult {
  readonly ok: boolean;
  readonly rounds: number;
  readonly exhausted: boolean;
  readonly results: readonly PackageVerdict[];
  readonly problems: readonly string[];
  readonly elapsedMs: number;
}

/** Read, judge, and re-read what has not converged, until every package settles or time runs out. */
export declare function assertDistTags(input: {
  expected: readonly { name: string; version: string }[];
  before: Record<string, DistTags | null> | undefined;
  read: (name: string) => Reading | Promise<Reading>;
  allowLatestMove?: boolean;
  deadlineMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void | Promise<void>;
}): Promise<AssertResult>;
