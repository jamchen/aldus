/**
 * Archival (contract §8.1, §25 item 4; ADR-0007).
 *
 * "Archived" means three things, and each is tested here: the bytes are addressed by their own
 * digest, they are read back and re-hashed before a receipt is issued, and archiving the same
 * bytes twice is a no-op rather than a rewrite.
 *
 * The suite runs against both implementations. An interface with one implementation has never
 * been shown to be an interface, and contract §21 lists "at least one alternative adapter or
 * test double proves substitutability" among the criteria for extracting Aldus as an open
 * runtime.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AldusError } from "@aldus-runtime/core";

import {
  LocalDirectoryArchive,
  MemoryArtifactArchive,
  type ArtifactArchive,
} from "../src/archive.js";
import { sha256Bytes } from "../src/digest.js";
import { ArtifactRegistryErrorCodes } from "../src/errors.js";
import { objectPath } from "../src/paths.js";

const NOW = "2026-01-01T00:00:00.000Z";
const CONTENT = "irreplaceable audio bytes";
const DIGEST = sha256Bytes(CONTENT);

let root: string;
let sourcePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aldus-archive-"));
  sourcePath = join(root, "source", "req-00.wav");
  await mkdir(join(root, "source"), { recursive: true });
  await writeFile(sourcePath, CONTENT, "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The behavioural contract every archive adapter must satisfy. */
function describeArchiveContract(name: string, make: () => ArtifactArchive): void {
  describe(`${name} (ArtifactArchive contract)`, () => {
    it("reports not holding a digest it has never seen", async () => {
      expect(await make().has(DIGEST)).toBe(false);
    });

    it("takes custody and issues a verified receipt", async () => {
      const archive = make();
      const receipt = await archive.put({ sourcePath, sha256: DIGEST, now: NOW });

      expect(receipt.sha256).toBe(DIGEST);
      expect(receipt.verified).toBe(true);
      expect(receipt.archivedAt).toBe(NOW);
      expect(receipt.sizeBytes).toBe(Buffer.byteLength(CONTENT));
      expect(receipt.archiveId).toBe(archive.archiveId);
      expect(await archive.has(DIGEST)).toBe(true);
    });

    it("returns the exact bytes it took custody of", async () => {
      const archive = make();
      await archive.put({ sourcePath, sha256: DIGEST, now: NOW });
      expect(Buffer.from(await archive.read(DIGEST)).toString("utf8")).toBe(CONTENT);
    });

    it("is idempotent", async () => {
      const archive = make();
      const first = await archive.put({ sourcePath, sha256: DIGEST, now: NOW });
      const second = await archive.put({
        sourcePath,
        sha256: DIGEST,
        now: "2026-06-01T00:00:00.000Z",
      });
      expect(second.uri).toBe(first.uri);
      expect(second.sha256).toBe(first.sha256);
    });

    it("refuses bytes that do not hash to the declared digest", async () => {
      // Storing bytes under an identity they do not have would create an archive that lies, and
      // every later verification would pass against the wrong key.
      const archive = make();
      let thrown: unknown;
      try {
        await archive.put({ sourcePath, sha256: "b".repeat(64), now: NOW });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AldusError);
      expect((thrown as AldusError).code).toBe(ArtifactRegistryErrorCodes.DIGEST_MISMATCH);
      expect(await archive.has("b".repeat(64))).toBe(false);
    });

    it("rejects a malformed digest rather than deriving a path from it", async () => {
      await expect(make().has("../../etc/passwd")).rejects.toThrowError(AldusError);
    });

    it("reports an unreadable source as a structured archive failure", async () => {
      // Failure must fail safe, toward retaining bytes: no receipt means the artifact stays
      // unarchived, which means cleanup keeps refusing to remove it. And it must be a
      // structured error, or this is the one path in the package that leaks a raw Node error.
      const archive = make();
      let thrown: unknown;
      try {
        await archive.put({ sourcePath: join(root, "does-not-exist"), sha256: DIGEST, now: NOW });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AldusError);
      expect((thrown as AldusError).code).toBe(ArtifactRegistryErrorCodes.ARCHIVE_FAILED);
      expect(await archive.has(DIGEST)).toBe(false);
    });

    it("reports a digest it does not hold rather than returning empty bytes", async () => {
      let thrown: unknown;
      try {
        await make().read(DIGEST);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as AldusError).code).toBe(ArtifactRegistryErrorCodes.ARTIFACT_NOT_FOUND);
    });

    it("stores two different artifacts with the same filename separately", async () => {
      const archive = make();
      const otherPath = join(root, "other", "req-00.wav");
      await mkdir(join(root, "other"), { recursive: true });
      await writeFile(otherPath, "different bytes entirely", "utf8");
      const otherDigest = sha256Bytes("different bytes entirely");

      await archive.put({ sourcePath, sha256: DIGEST, now: NOW });
      await archive.put({ sourcePath: otherPath, sha256: otherDigest, now: NOW });

      expect(Buffer.from(await archive.read(DIGEST)).toString("utf8")).toBe(CONTENT);
      expect(Buffer.from(await archive.read(otherDigest)).toString("utf8")).toBe(
        "different bytes entirely",
      );
    });
  });
}

describeArchiveContract(
  "LocalDirectoryArchive",
  () => new LocalDirectoryArchive(join(root, "archive")),
);
describeArchiveContract("MemoryArtifactArchive", () => new MemoryArtifactArchive());

describe("LocalDirectoryArchive specifics", () => {
  it("places objects at a content-derived path", async () => {
    const archiveRoot = join(root, "archive");
    const archive = new LocalDirectoryArchive(archiveRoot);
    await archive.put({ sourcePath, sha256: DIGEST, now: NOW });

    const expected = objectPath(archiveRoot, DIGEST);
    expect(await archive.locate(DIGEST)).toBe(expected);
    expect(await readFile(expected, "utf8")).toBe(CONTENT);
    // Nothing the producer named the file appears anywhere in the stored path.
    expect(expected).not.toContain("req-00");
  });

  it("detects a corrupted archived object rather than reporting custody", async () => {
    // The whole point of the pre-cleanup archival gate is that the archived copy is real. An
    // archive that reports custody of bytes it has silently lost is worse than one that reports
    // nothing, because cleanup trusts this answer before deleting the only other copy.
    const archiveRoot = join(root, "archive");
    const archive = new LocalDirectoryArchive(archiveRoot);
    await archive.put({ sourcePath, sha256: DIGEST, now: NOW });
    await writeFile(objectPath(archiveRoot, DIGEST), "silently corrupted", "utf8");

    let thrown: unknown;
    try {
      await archive.put({ sourcePath, sha256: DIGEST, now: NOW });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AldusError).code).toBe(ArtifactRegistryErrorCodes.ARCHIVE_CORRUPT);
  });

  it("uses a caller-supplied archive id", () => {
    expect(new LocalDirectoryArchive(root, { archiveId: "archive-b" }).archiveId).toBe("archive-b");
  });
});
