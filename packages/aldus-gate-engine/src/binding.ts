/**
 * Binding a decision to exact inputs (architecture contract §13).
 *
 * Contract §3.6: a decision must be "tied to exact inputs". §13.1 and §13.2 turn that into a
 * requirement — a Content Freeze is void once the content changes, and a TTS authorization "MUST
 * be invalidated if any bound value changes". `GateDecision.subjectHashes` is the mechanism.
 *
 * Two design choices here are load-bearing.
 *
 * **The stored hashes are the raw content digests, not digests of `key + value`.** Hashing the
 * pair would bind the key association more tightly, but it would also make a `subjectHash`
 * unmatchable against an `ArtifactRef.sha256`, and §20 requires production trace to answer which
 * inputs produced a result. Interoperability with the artifact record is worth more than the
 * marginal strength, because the key association is recovered below anyway.
 *
 * **Comparison is over a sorted multiset, and there is no sidecar record of key-to-hash.** A
 * separate record mapping keys to hashes could drift from the decision it describes, and a
 * safety check that depends on two records agreeing fails open the day they disagree. Instead the
 * check is a direct comparison against `subjectHashes`, and the key-level explanation is
 * *derived* by diffing current subjects against that same list. If the explanation is imperfect
 * the check is still exact — the ordering that matters.
 */

import { createHash } from "node:crypto";

import type { GateDecision } from "@aldus-runtime/core";

import type { ResolvedGateDefinition } from "./definition.js";
import { GateEngineErrorCodes, gateEngineError } from "./errors.js";

/** One named input a gate binds, and the digest of its current value. */
export interface GateSubject {
  /**
   * What this subject is, e.g. a spoken-text hash or a request plan (contract §13.2).
   *
   * An OPEN string. What a gate binds is adopter process (§4.3), so Core names no subject keys.
   */
  key: string;
  /** Lowercase hex SHA-256 of the subject's current value. */
  sha256: string;
}

/** Matches Core's `sha256Hex`: lowercase only, so digests compare by equality. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Digest an arbitrary value for use as a subject.
 *
 * Serialisation is canonical — object keys sorted at every depth — so that two structurally
 * identical settings objects produce the same digest regardless of how they were built. Without
 * that, re-serialising an unchanged voice-settings object in a different key order would read as
 * a changed bound value and void a valid authorization (§13.2).
 */
export function digestSubjectValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Digest raw bytes or text for use as a subject. */
export function digestBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON with object keys sorted at every depth. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Check that the supplied subjects cover exactly what the gate binds, and are well formed.
 *
 * A missing subject is refused rather than treated as unchanged. §13.2 requires the operator to
 * approve every listed value, so an authorization that silently omitted one would bind less than
 * the contract requires while still reading as valid.
 *
 * @throws {AldusError} `ALDUS_GATE_SUBJECTS_INCOMPLETE`
 */
export function assertSubjectsCover(
  gate: ResolvedGateDefinition,
  subjects: readonly GateSubject[],
): void {
  const supplied = new Map<string, string>();
  for (const subject of subjects) {
    if (!SHA256_PATTERN.test(subject.sha256)) {
      throw gateEngineError(
        GateEngineErrorCodes.GATE_SUBJECTS_INCOMPLETE,
        `Subject "${subject.key}" for gate "${gate.gateId}" is not a lowercase hex SHA-256. ` +
          "Mixed-case or truncated digests would compare unequal to an identical value.",
        { category: "validation", details: { gateId: gate.gateId, key: subject.key } },
      );
    }
    if (supplied.has(subject.key)) {
      throw gateEngineError(
        GateEngineErrorCodes.GATE_SUBJECTS_INCOMPLETE,
        `Subject "${subject.key}" was supplied twice for gate "${gate.gateId}".`,
        { category: "validation", details: { gateId: gate.gateId, key: subject.key } },
      );
    }
    supplied.set(subject.key, subject.sha256);
  }

  const missing = gate.binds.filter((key) => !supplied.has(key));
  const unexpected = [...supplied.keys()].filter((key) => !gate.binds.includes(key));

  if (missing.length > 0 || unexpected.length > 0) {
    throw gateEngineError(
      GateEngineErrorCodes.GATE_SUBJECTS_INCOMPLETE,
      `Gate "${gate.gateId}" binds [${gate.binds.join(", ")}], but was given ` +
        `[${[...supplied.keys()].join(", ")}]. Contract §13.2 requires an authorization to bind ` +
        "every listed value; binding a different set is not the same approval.",
      {
        category: "validation",
        details: { gateId: gate.gateId, missing, unexpected, binds: [...gate.binds] },
      },
    );
  }
}

/**
 * The canonical `subjectHashes` for a set of subjects.
 *
 * Sorted so that the order subjects were supplied in cannot change the stored value, and kept as
 * a list rather than a set so two subjects that happen to share a value stay two subjects.
 */
export function toSubjectHashes(subjects: readonly GateSubject[]): string[] {
  return subjects.map((subject) => subject.sha256).sort();
}

/** Why a decision no longer binds the current inputs. */
export interface SubjectDrift {
  /** Subject keys whose current digest is not among the approved hashes. */
  changed: string[];
  /** Approved hashes no longer matched by any current subject. */
  orphanedHashes: string[];
}

/**
 * Compare current subjects against what a decision approved.
 *
 * Returns `undefined` when they match exactly. Otherwise names the keys whose values moved, which
 * is what an operator needs in order to know what to re-approve.
 *
 * The key attribution is best-effort by design: it is derived from the hashes rather than stored
 * alongside them, so an exotic case — two subjects sharing one value, one of which changed — may
 * name both. The *detection* is exact regardless, and detection is what §13.2 requires.
 */
export function detectDrift(
  decision: GateDecision,
  subjects: readonly GateSubject[],
): SubjectDrift | undefined {
  const approved = [...decision.subjectHashes].sort();
  const current = toSubjectHashes(subjects);

  if (approved.length === current.length && approved.every((hash, i) => hash === current[i])) {
    return undefined;
  }

  const approvedCounts = new Map<string, number>();
  for (const hash of approved) approvedCounts.set(hash, (approvedCounts.get(hash) ?? 0) + 1);

  const changed: string[] = [];
  for (const subject of subjects) {
    const remaining = approvedCounts.get(subject.sha256) ?? 0;
    if (remaining > 0) approvedCounts.set(subject.sha256, remaining - 1);
    else changed.push(subject.key);
  }

  const orphanedHashes: string[] = [];
  for (const [hash, count] of approvedCounts) {
    for (let i = 0; i < count; i += 1) orphanedHashes.push(hash);
  }

  return { changed, orphanedHashes: orphanedHashes.sort() };
}
