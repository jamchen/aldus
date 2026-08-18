/**
 * Release authorization (architecture contract §13.4, §17, §18.1).
 *
 * This package does **not** decide whether a release is approved. `@aldus-runtime/gate-engine` already
 * models §13.4's separation of uploading from making public as two gates granting two
 * operations, and derives staleness from bound digests (ADR-0009). Re-deciding any of that here
 * would produce a second approval path — and §3.6 exists because a second path is how an
 * approval that nobody recorded ends up authorizing something.
 *
 * So the executor consumes a verdict through a narrow port, and {@link gateEngineAuthorizer}
 * wires that port to the real engine.
 */

import type { GateEngine, SubjectsByGate } from "@aldus-runtime/gate-engine";

/** A verdict on one operation's authority. */
export interface AuthorityVerdict {
  authorized: boolean;
  /** Why not, when refused. Shown to an operator, so it must name the gate. */
  explanation?: string;
  /** The gate that granted it, when authorized — recorded for trace (contract §20). */
  gateId?: string;
}

/**
 * Whatever decides if a release operation may proceed.
 *
 * A port rather than a direct dependency so that the executor can be tested against a refusal
 * without constructing a gate graph, and so an adopter with its own authority model can supply
 * one. The shipped implementation is {@link gateEngineAuthorizer}.
 */
export interface ReleaseAuthorizer {
  /**
   * Whether `authority` is currently held for this Run.
   *
   * `authority` is the operation string a gate grants, e.g. the separate upload and publication
   * authorities of §13.4.
   */
  check(runId: string, authority: string): Promise<AuthorityVerdict>;
}

/**
 * A {@link ReleaseAuthorizer} backed by the gate engine (contract §13).
 *
 * `subjects` are the current digests of everything the gates bind — the final render, captions,
 * metadata, destination, and visibility policy of §13.4. They are supplied by the caller and
 * read afresh on every check, so an approval that was valid when the bundle was assembled and
 * has since drifted is refused at the moment of release rather than at the moment of planning.
 */
export function gateEngineAuthorizer(
  engine: GateEngine,
  subjects: SubjectsByGate | (() => SubjectsByGate | Promise<SubjectsByGate>),
): ReleaseAuthorizer {
  return {
    async check(runId: string, authority: string): Promise<AuthorityVerdict> {
      const current = typeof subjects === "function" ? await subjects() : subjects;
      const result = await engine.authorize(runId, authority, current);
      return result.authorized
        ? { authorized: true, gateId: result.gateId }
        : { authorized: false, explanation: result.explanation };
    },
  };
}

/**
 * An authorizer that permits everything.
 *
 * For operations that genuinely need no approval, and for tests exercising execution mechanics
 * rather than authority. Deliberately named for what it does: a default called
 * `defaultAuthorizer` would be reached for without the reader noticing it approves everything.
 */
export function permitAllAuthorizer(): ReleaseAuthorizer {
  return { check: () => Promise.resolve({ authorized: true }) };
}
