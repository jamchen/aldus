/**
 * Release operations (architecture contract §17).
 *
 * §17 requires that "pre-release hard gates and post-upload best-effort operations MUST be
 * distinguished". The distinction is made **structurally** rather than with a severity field:
 * a required operation and a best-effort one are different types, produced by different
 * constructors, and held in different arrays of a {@link ReleaseBundle}.
 *
 * A `criticality: "required" | "best_effort"` field would have been smaller, and wrong. A field
 * is set at a call site, often far from where the consequence lands, and setting it incorrectly
 * turns a failed thumbnail into a failed release or — far worse — a failed media upload into a
 * release that reports success. Requiring the caller to *place* the operation in one list or the
 * other makes the mistake a type error rather than a typo.
 */

/**
 * Brand distinguishing the two operation categories at the type level.
 *
 * Declared but never exported as a value, so an operation of either kind can only come from the
 * constructor below. A caller cannot hand-write an object literal that satisfies
 * {@link RequiredOperation}.
 */
import { ReleaseErrorCodes, releaseError } from "./errors.js";

declare const CRITICALITY: unique symbol;

/** @see RepeatableDeclaration */
declare const REPEATABILITY: unique symbol;

/**
 * A statement that an operation's effect may be performed more than once (§17, §19.1; #169).
 *
 * Minted by {@link repeatable} and not writable as an object literal, for the same reason
 * `RequiredOperation` is not: this licenses re-performing a real external effect, and a shape a
 * caller can assemble is a shape that gets assembled from configuration by someone who has not
 * thought about it.
 *
 * The reason is **required**. An operation that may be repeated is one an approver is being asked
 * to accept the repetition of, and "safe to repeat" with no account of why is not something anyone
 * can approve or audit.
 */
export interface RepeatableDeclaration {
  readonly [REPEATABILITY]: "repeatable";
  /**
   * Why repeating this effect is safe, for the approver and for the operator.
   *
   * Shown in the reconciliation finding that records the operation was not queried, so a reader
   * sees the justification rather than only the outcome.
   */
  readonly reason: string;
}

/**
 * Declare that repeating this operation's effect is safe (§17, §19.1; #169).
 *
 * @throws {AldusError} when the reason is empty. A declaration that licenses repetition and says
 * nothing about why is the thing this exists to prevent.
 */
export function repeatable(reason: string): RepeatableDeclaration {
  if (reason.trim().length === 0) {
    throw releaseError(
      ReleaseErrorCodes.OPERATION_INVALID,
      "A repeatable declaration must say why repeating the effect is safe. It licenses performing " +
        "an external effect more than once, and an approver cannot accept that from a bare flag " +
        "(contract §13.4, §17).",
      { category: "validation", retryable: false, details: {} },
    );
  }
  return { reason } as RepeatableDeclaration;
}

/** Fields shared by both categories. */
export interface ReleaseOperationBase {
  /**
   * Identity of this operation within its bundle.
   *
   * Stable across resumption: it is how a stored receipt is matched back to the operation that
   * produced it, so renaming one orphans its receipt.
   */
  operationId: string;
  /**
   * What kind of operation this is, e.g. a media upload, a caption attachment, or a visibility
   * transition.
   *
   * An OPEN string, never a Core-defined enum. Contract §17 lists candidate operations — media
   * upload, captions, thumbnail, title and description, privacy transition, playlist, podcast
   * storage and RSS, notification channels — as an illustration of what an adopter might need,
   * and §4.2 keeps adopter process out of the runtime. Do not narrow this to a union.
   */
  kind: string;
  /**
   * Where the operation is directed.
   *
   * An OPEN string. Contract §1.2 explicitly rules out prescribing particular release targets,
   * so a destination is an adopter's name for one of its own, resolved to an adapter at
   * execution time.
   */
  destination: string;
  /**
   * Digests of exactly what this operation releases (contract §13.4).
   *
   * §13.4 requires release approval to bind to the final render, captions, metadata,
   * destination, and visibility policy. These digests are what an approval binds, and they feed
   * the idempotency key, so changing what is released changes the operation's identity.
   */
  inputHashes: readonly string[];
  /**
   * The authority this operation requires, if any (contract §13.4, §18.1).
   *
   * Names an operation string a gate grants — for example the separate upload and publication
   * authorities §13.4 demands. Left absent only for operations that genuinely need no approval.
   * The gate engine decides whether the authority is held; this package never re-decides it.
   */
  requiresAuthority?: string;
  /**
   * Declares that repeating this operation's effect is safe (§17, §19.1; #169).
   *
   * **Absent means one-shot**, which is the conservative reading and the behaviour every existing
   * bundle already has. Repetition is licensed only by saying so.
   *
   * In the **bundle**, not on the adapter and not in `RemoteState`. §13.4 binds a release approval
   * to the bundle, so a fact that licenses re-performing an effect has to be visible in the
   * artifact an approver approved — an adapter-side flag would let an adapter license repeating an
   * operation the approver believed happened once.
   *
   * Not inferable from {@link ReleaseOperationBase} either. `deriveIdempotencyKey` documents its
   * result as the key that makes re-running safe, and that holds only where the destination
   * honours the key; plenty do not. A key's presence is a request, not a guarantee, so
   * repeatability has to be stated.
   */
  repeatable?: RepeatableDeclaration;
  /** Opaque parameters passed through to the adapter. Never inspected here. */
  parameters?: Readonly<Record<string, unknown>>;
}

/**
 * An operation whose failure fails the release (contract §17 "pre-release hard gates").
 *
 * Required operations run in declaration order, and the first failure stops the bundle: a media
 * upload that failed must not be followed by a visibility transition making nothing public.
 */
export interface RequiredOperation extends ReleaseOperationBase {
  readonly [CRITICALITY]: "required";
}

/**
 * An operation whose failure is recorded but does not fail the release (contract §17
 * "post-upload best-effort operations").
 *
 * A failed thumbnail or notification leaves a `failed` receipt and an operator-visible warning;
 * it does not undo an upload that succeeded.
 */
export interface BestEffortOperation extends ReleaseOperationBase {
  readonly [CRITICALITY]: "best_effort";
}

/** Either category, where only the shared fields matter. */
export type ReleaseOperation = RequiredOperation | BestEffortOperation;

/** Declare an operation whose failure fails the release (contract §17). */
export function requiredOperation(operation: ReleaseOperationBase): RequiredOperation {
  return { ...operation } as RequiredOperation;
}

/** Declare an operation whose failure is recorded but tolerated (contract §17). */
export function bestEffortOperation(operation: ReleaseOperationBase): BestEffortOperation {
  return { ...operation } as BestEffortOperation;
}

/**
 * Which category an operation belongs to.
 *
 * Derived from where the bundle holds it rather than read off the operation, because the arrays
 * are the source of truth — see this module's header.
 */
export type OperationCriticality = "required" | "best_effort";
