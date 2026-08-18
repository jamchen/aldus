/**
 * Structured errors.
 *
 * Architecture contract §19.1 requires structured errors; §11 requires a stage to produce
 * "declared outputs or a structured failure". §19.2 requires that logs redact credentials, so
 * an error is a **redacted, safe-to-persist** value: it is written into `events.jsonl`,
 * `StageAttempt.error`, and `ReleaseReceipt.error`, all of which are durable and reviewable.
 *
 * The Zod schema is the single source of truth (ADR-0002); the TypeScript type is inferred.
 */

import { z } from "zod";

/**
 * Coarse failure classification. Deliberately small and generic: it drives retry policy and
 * operator triage, not provider-specific handling. Contract §4.2 forbids Core from naming a
 * provider, so provider failures collapse into `provider`.
 */
export const ERROR_CATEGORIES = [
  /** Input did not satisfy a declared schema or contract precondition. */
  "validation",
  /** A rule refused the operation: cost limit, missing approval, unmet gate (§13, §19.3). */
  "policy",
  /** A referenced entity does not exist. */
  "not_found",
  /** Concurrent or contradictory state: lease held, hash-bound approval invalidated (§19.1). */
  "conflict",
  /** An external provider or platform failed. Core never names which (§4.2). */
  "provider",
  /** Filesystem, network, or storage failure. */
  "io",
  /** An operation exceeded its allowed duration. */
  "timeout",
  /** The operation was cancelled by an operator or a supervising runtime (§19.1). */
  "cancelled",
  /** A defect in Aldus itself. Never used for expected failure modes. */
  "internal",
] as const;

/** @see ERROR_CATEGORIES */
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Maximum depth of the `causes` chain that will be constructed or validated. A cause chain is
 * an audit aid, not a stack trace; unbounded nesting is a denial-of-service vector on any
 * component that persists or renders errors.
 */
export const MAX_ERROR_CAUSE_DEPTH = 4;

/**
 * Structured error (contract §19.1).
 *
 * `message` and `details` MUST already be safe to persist and log. Producers pass untrusted
 * content through `redact()` before constructing an error — an error is never the place where
 * redaction is deferred to a later layer.
 */
export interface StructuredError {
  /** Stable machine-readable code, `SCREAMING_SNAKE_CASE`. Consumers branch on this, not on `message`. */
  code: string;
  /** Coarse classification driving retry and triage. */
  category: ErrorCategory;
  /** Human-readable, already redacted. */
  message: string;
  /** Whether retrying the identical operation could plausibly succeed (§19.1 retry classification). */
  retryable: boolean;
  /** Structured context. Already redacted. MUST NOT contain a received input value verbatim. */
  details?: Record<string, unknown> | undefined;
  /** Underlying failures, outermost first. Bounded by {@link MAX_ERROR_CAUSE_DEPTH}. */
  causes?: StructuredError[] | undefined;
  /** ISO-8601 timestamp with offset. */
  occurredAt?: string | undefined;
}

/**
 * Zod schema for {@link StructuredError}. Recursive via a lazy getter on `causes`.
 *
 * Depth is not enforced by the schema — JSON Schema cannot express "at most N levels of
 * recursion" — so {@link truncateCauses} enforces it at construction time instead.
 */
export const structuredErrorSchema: z.ZodType<StructuredError> = z
  .object({
    code: z.string().min(1).max(200),
    category: z.enum(ERROR_CATEGORIES),
    message: z.string().max(4000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
    get causes() {
      return z.array(structuredErrorSchema).max(16).optional();
    },
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({
    id: "StructuredError",
    title: "StructuredError",
    description:
      "A redacted, safe-to-persist failure record (architecture contract §19.1). `message` and " +
      "`details` are already redacted by the producer. Cause chains are bounded to " +
      `${MAX_ERROR_CAUSE_DEPTH} levels at construction time, a constraint JSON Schema cannot express.`,
  });

/**
 * Error codes raised by Aldus Core itself.
 *
 * Other packages define their own codes; there is no central registry, because a closed
 * enumeration would force every adopter integration to fork Core to report a new failure.
 */
export const CoreErrorCodes = {
  /** A value failed schema validation. */
  SCHEMA_VALIDATION_FAILED: "ALDUS_SCHEMA_VALIDATION_FAILED",
  /** A `schemaVersion` string was not `MAJOR.MINOR`. */
  SCHEMA_VERSION_MALFORMED: "ALDUS_SCHEMA_VERSION_MALFORMED",
  /** A record's schema major version is not readable by this build (ADR-0003). */
  SCHEMA_VERSION_UNSUPPORTED: "ALDUS_SCHEMA_VERSION_UNSUPPORTED",
  /** An unknown schema name was requested from the registry. */
  SCHEMA_UNKNOWN: "ALDUS_SCHEMA_UNKNOWN",
  /** An identifier was malformed or carried the wrong prefix. */
  ID_INVALID: "ALDUS_ID_INVALID",
  /**
   * Monotonic ID randomness was exhausted within a single millisecond.
   *
   * Distinct from {@link CoreErrorCodes.ID_INVALID}: nothing the caller passed was wrong, and
   * retrying in the next millisecond succeeds. Separating them keeps "your input was bad" and
   * "the generator hit a ceiling" from sharing one code in production trace (§20).
   */
  ID_EXHAUSTED: "ALDUS_ID_EXHAUSTED",
  /** A canonical content identity could not be parsed or formatted. */
  IDENTITY_INVALID: "ALDUS_IDENTITY_INVALID",
} as const;

/** @see CoreErrorCodes */
export type CoreErrorCode = (typeof CoreErrorCodes)[keyof typeof CoreErrorCodes];

/** Default retryability by category. Overridable per error. */
const DEFAULT_RETRYABLE: Record<ErrorCategory, boolean> = {
  validation: false,
  policy: false,
  not_found: false,
  conflict: false,
  provider: true,
  io: true,
  timeout: true,
  cancelled: false,
  internal: false,
};

/** Options accepted by {@link AldusError}. */
export interface AldusErrorOptions {
  category: ErrorCategory;
  /** Defaults to {@link DEFAULT_RETRYABLE} for the category. */
  retryable?: boolean;
  /** Already-redacted structured context. */
  details?: Record<string, unknown>;
  /** Underlying failures, already structured. */
  causes?: StructuredError[];
  /** ISO-8601 timestamp with offset. Omitted rather than invented when unknown. */
  occurredAt?: string;
}

/**
 * Throwable carrier for a {@link StructuredError}.
 *
 * Core APIs prefer returning a result over throwing (see `validate` vs `assertValid`), but a
 * throwing form is needed at boundaries where a return value cannot express failure.
 */
export class AldusError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly causes: StructuredError[] | undefined;
  readonly occurredAt: string | undefined;

  constructor(code: string, message: string, options: AldusErrorOptions) {
    super(message);
    this.name = "AldusError";
    this.code = code;
    this.category = options.category;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[options.category];
    this.details = options.details;
    this.causes = options.causes ? truncateCauses(options.causes) : undefined;
    this.occurredAt = options.occurredAt;
  }

  /** Project to the persistable record shape. */
  toStructuredError(): StructuredError {
    const error: StructuredError = {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) error.details = this.details;
    if (this.causes !== undefined) error.causes = this.causes;
    if (this.occurredAt !== undefined) error.occurredAt = this.occurredAt;
    return error;
  }

  /** JSON form is the structured record, so `JSON.stringify` on a thrown error stays useful. */
  toJSON(): StructuredError {
    return this.toStructuredError();
  }
}

/**
 * Convert an unknown thrown value into a {@link StructuredError}.
 *
 * Native `Error` messages may embed arbitrary interpolated content, so the caller is
 * responsible for redacting before this value reaches a log or a durable record.
 */
export function toStructuredError(
  thrown: unknown,
  fallback: { code: string; category: ErrorCategory } = {
    code: "ALDUS_UNEXPECTED_ERROR",
    category: "internal",
  },
): StructuredError {
  if (thrown instanceof AldusError) return thrown.toStructuredError();
  if (thrown instanceof Error) {
    return {
      code: fallback.code,
      category: fallback.category,
      message: thrown.message,
      retryable: DEFAULT_RETRYABLE[fallback.category],
      details: { errorName: thrown.name },
    };
  }
  return {
    code: fallback.code,
    category: fallback.category,
    message: typeof thrown === "string" ? thrown : "Non-error value was thrown.",
    retryable: DEFAULT_RETRYABLE[fallback.category],
  };
}

/** Trim a cause chain to {@link MAX_ERROR_CAUSE_DEPTH} levels, dropping deeper nesting. */
export function truncateCauses(
  causes: StructuredError[],
  depth: number = MAX_ERROR_CAUSE_DEPTH,
): StructuredError[] {
  if (depth <= 1) return causes.map(({ causes: _dropped, ...rest }) => rest);
  return causes.map((cause) =>
    cause.causes === undefined
      ? cause
      : { ...cause, causes: truncateCauses(cause.causes, depth - 1) },
  );
}
