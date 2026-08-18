/**
 * Content digests.
 *
 * Architecture contract §8.1 makes `artifactId` plus `sha256` the identity of an artifact, and
 * §13 binds gate decisions to `subjectHashes`. A digest here is therefore not a checksum used
 * for opportunistic integrity checking — it is the thing approvals point at. A wrong digest
 * silently redirects an approval to different bytes.
 *
 * Digests are lowercase hexadecimal throughout, matching Core's `sha256Hex`. Mixed case would
 * break equality comparison between a stored digest and a computed one, and equality is what
 * every guarantee in this package rests on.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { ArtifactRegistryErrorCodes, artifactRegistryError } from "./errors.js";

/** Exactly 64 lowercase hexadecimal characters. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** True if `value` is a well-formed lowercase SHA-256 digest. */
export function isSha256Hex(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

/**
 * Normalise a digest from an external tool to Core's lowercase form.
 *
 * Uppercase hexadecimal is a legitimate output of many tools, so it is accepted and folded here
 * — at the boundary — rather than by relaxing the schema. Anything else is rejected: a digest
 * that is not 64 hex characters is not a SHA-256, and coercing it would produce an identity
 * nothing can verify.
 *
 * @throws {AldusError} `ALDUS_DIGEST_MALFORMED`
 */
export function normaliseDigest(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (!isSha256Hex(lowered)) {
    throw artifactRegistryError(
      ArtifactRegistryErrorCodes.DIGEST_MALFORMED,
      "A SHA-256 digest must be 64 hexadecimal characters. " +
        `Received ${value.length} character(s).`,
      {
        category: "validation",
        retryable: false,
        // The value itself is withheld: a malformed "digest" is arbitrary caller input and may
        // be anything at all, including a credential someone passed to the wrong parameter.
        details: { receivedLength: value.length },
      },
    );
  }
  return lowered;
}

/** Digest of an in-memory buffer or string. */
export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Digest a file by streaming it.
 *
 * Streamed rather than read whole: an approved audio take or a rendered video is routinely
 * larger than a comfortable buffer, and reading it into memory to hash it would make artifact
 * size a limit on the runtime rather than on the filesystem.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

/** A file's digest and size, collected in one pass over the filesystem. */
export interface FileDigest {
  sha256: string;
  sizeBytes: number;
}

/** Digest a file and record its size (contract §8 `sha256`, `sizeBytes`). */
export async function digestFile(path: string): Promise<FileDigest> {
  const [sha256, stats] = await Promise.all([sha256File(path), stat(path)]);
  return { sha256, sizeBytes: stats.size };
}

/**
 * Confirm that a file still hashes to `expected`.
 *
 * @throws {AldusError} `ALDUS_DIGEST_MISMATCH` if the bytes have changed.
 */
export async function verifyFileDigest(path: string, expected: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== normaliseDigest(expected)) {
    throw artifactRegistryError(
      ArtifactRegistryErrorCodes.DIGEST_MISMATCH,
      "The bytes at this location no longer match the digest recorded for them. The artifact " +
        "has been modified or replaced since it was registered.",
      { category: "io", retryable: false, details: { path, expected, actual } },
    );
  }
}

/**
 * Digest of a configuration object, for contract §8.1's requirement that an artifact record
 * "which stage, run, code revision, and configuration produced it".
 *
 * Object keys are sorted recursively before serialisation, so two configurations that differ
 * only in key order produce the same digest. Without that, a configuration that never changed
 * would appear to change whenever a producer happened to build it differently, and §13.2's
 * hash-bound TTS authorization would be invalidated for no reason.
 */
export function digestConfiguration(configuration: unknown): string {
  return sha256Bytes(canonicalJson(configuration));
}

/** JSON with object keys in sorted order at every depth. Arrays keep their order, which is data. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
  return `{${entries.join(",")}}`;
}
