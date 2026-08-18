# ADR-0007: Artifact archive target, collision safety, and provenance placement

- Status: Accepted
- Date: 2026-08-18
- Closes: architecture contract §25 item 4 (artifact archive target for irreplaceable audio)
- Relates to: §8 Artifact model, §8.1 Artifact rules, §1.1 V1 goals, §15.1, §21, ADR-0004, ADR-0005

## Context

Contract §25 item 4 leaves the archive target for irreplaceable audio open. §8.1 states the rule
that target has to serve:

> Irreplaceable artifacts MUST be archived before disposable working files are cleaned.

and, in the same list, the concrete failure the registry exists to prevent:

> Generic names such as `req-00.wav` MUST NOT overwrite accepted audio from another Episode.

§1.1 names "loss or overwrite of accepted audio takes" among the things V1 must reduce. These are
the same failure seen from two directions: a paid, human-approved take (§13.3) exists exactly
once, and both an overwrite and a premature cleanup destroy it permanently. §8 classifies such an
artifact `irreplaceable` precisely because no re-run recovers it.

Three questions had to be answered together, because the answer to each constrains the others:
where archived bytes live, how a path is chosen so that two artifacts cannot collide, and where
the provenance §8.1 requires is recorded given that `ArtifactRef` has no field for most of it.

## Decision

### 1. Storage paths are derived from content, never from a filename

Every path the registry produces is a pure function of a SHA-256 digest:
`<root>/<aa>/<bb>/<digest>`. Nothing the producer called the file participates.

§8.1 states that a path or filename MUST NOT be treated as identity. The corollary adopted here
is the active form of the same rule: **identity determines the path.** Two artifacts can only
land in the same place if their bytes are identical, and identical bytes are the one case where
sharing storage is correct rather than destructive.

This makes the `req-00.wav` failure structurally impossible rather than merely discouraged. A
naming convention would have relied on every producer — including the wrapped legacy scripts §3.7
anticipates — following it.

Two levels of two hexadecimal characters shard the store. Flat content-addressed directories
degrade badly past tens of thousands of entries on some filesystems, and a run of segmented audio
reaches that quickly.

A separate `readableFileName()` exists for export and inspection: it keeps the producer's name and
prefixes a digest fragment, so an operator listening to takes sees `a3f1c0d2-req-00.wav` rather
than a bare hash. It is explicitly not identity, and nothing reads it back.

### 2. The V1 archive is a local content-addressed directory behind an adapter

`ArtifactArchive` is the seam; `LocalDirectoryArchive` is the V1 implementation, rooted at
`.aldus/archive`. §4.2 forbids Core and its packages from depending on a cloud or storage service,
so no remote target is named anywhere — an archive is identified by an opaque `archiveId` the
adapter chooses.

The interface is deliberately narrow: take custody, report whether a digest is held, hand bytes
back. It does not enumerate, expire, or reason about artifacts, because those are the registry's
job and a remote archive would implement them badly.

### 3. "Archived" means verified custody, and archival is idempotent

A receipt is issued only after the archive **re-reads the stored bytes and re-hashes them**. An
archive that reports custody of bytes it has silently lost is worse than one that reports nothing,
because §8.1's cleanup gate trusts this answer immediately before deleting the only other copy.

`ArchiveReceipt.verified` records this. A receipt with `verified: false` does not satisfy the
pre-cleanup requirement — the field exists so a future adapter that genuinely cannot verify (a
write-only or eventually-consistent target) can say so rather than overstate.

Archiving bytes already held verifies and returns the existing receipt rather than rewriting.

### 4. A failed archive issues no receipt

Failure produces a structured `ALDUS_ARCHIVE_FAILED` and no receipt, which leaves the artifact
unarchived, which leaves cleanup refusing to remove it. **Failure therefore fails safe, toward
retaining bytes.** Any design where a partial or optimistic receipt could be recorded would fail
in the direction of deletion, which is the one direction that is unrecoverable.

### 5. Cleanup plans, then refuses — it never skips

`planCleanup` decides before anything is removed; `executeCleanup` refuses the whole plan if any
entry is blocked, rather than quietly cleaning the rest.

Skipping was the alternative and is rejected. A cleanup that omitted the blocked files would
report success while leaving the operator believing the workspace was tidied, and the next run
would silently omit the same files again. A refusal makes the operator resolve the archive gap
deliberately — which is a single `archiveIrreplaceable()` call, so the safe path is also the easy
one.

Registry **records** are never removed by cleanup, only working files. §8.1 makes the record the
identity; erasing it would make every approval that referenced the artifact undecipherable. §15.1
likewise requires rejected takes to be retained with unique identity, so `supersede` records a
replacement edge without deleting the replaced record.

Nothing deletes on a schedule. Retention policy enforcement is out of scope for WP-03: the
registry reports what retention would permit and a caller decides.

### 6. Provenance lives on a registry record, not on `ArtifactRef`

§8.1 requires an artifact to record "which stage, run, **code revision, and configuration**
produced it", and that a provider seed "MUST be recorded but MUST NOT be treated as a
reproducibility guarantee". `ArtifactRef` carries only run and stage.

The missing fields go on `ArtifactProvenance`, part of the registry's `ArtifactRecord`, rather
than onto `ArtifactRef` in Core. Two reasons:

- `ArtifactRef`'s field list is transcribed verbatim from the contract and guarded by a
  conformance test, so widening it is a deliberate departure from the contract's own text and
  would need to be added to that test's sanctioned list.
- A seed is a §15 synthesis concept. Putting it on the universal artifact reference would attach
  a synthesis-specific field to every storyboard, caption, and render manifest in the system.

`register()` takes `provenance` as a **required** parameter, so "MUST record" is enforced by the
type system rather than left to a producer's diligence. Its individual fields are optional, so a
wrapped legacy script (§3.7) that genuinely knows none of them passes `{}` — an explicit "nothing
known", which is honest, rather than a silently omitted argument.

Nothing anywhere re-derives an artifact from a recorded seed, and `requiresArchiveBeforeCleanup`
deliberately does not treat the presence of a seed as making an artifact reproducible. §1.2 states
outright that Aldus does not guarantee a seed reproduces identical audio.

### 7. The storage ports stay in their packages for now

WP-02 left `EpisodeStore`, `RunStore`, and `EventStore` in `@aldus/file-store` rather than Core,
reasoning that moving them would freeze member lists only one adapter had exercised. Adding
`ArtifactStore` was the moment to revisit that, and the answer is **not yet** — with one
distinction worth recording.

`ArtifactStore` has exactly one implementation, so it is in the same position as the WP-02 ports:
two single-adapter ports are not more evidence of substitutability than one. §21's own extraction
criterion is "at least one alternative adapter or test double proves substitutability."

`ArtifactArchive` **does** meet that bar. It has two implementations —
`LocalDirectoryArchive` and `MemoryArtifactArchive` — and both pass the same shared contract
suite. That seam is proven, and it is proven precisely because writing the second implementation
changed the first's interface.

Concrete trigger for moving the storage ports to Core: when a second adapter for any of them
exists, or when WP-04 or WP-08 needs to inject a test double. Until then, moving them would be
publishing a shape rather than a contract.

## Consequences

- The `req-00.wav` failure cannot occur through the registry. A test reproduces the raw overwrite,
  then proves both takes survive with distinct identities, distinct archive locations, and
  independent addressability by ID and by hash.
- Identical bytes registered twice are two artifacts sharing one stored object. Both records and
  both provenances survive; only storage is shared.
- The archive grows monotonically. Nothing in WP-03 removes an archived object, because deciding
  that an approved take is no longer needed is a retention decision this package does not own.
- `ArtifactProvenance` is not in Core, so a non-TypeScript consumer reading Core's published JSON
  Schema sees `ArtifactRef` without the §8.1 provenance fields. That is a real gap in the
  published contract, and the argument for closing it strengthens if a second registry
  implementation appears — at which point provenance is a shared domain shape rather than one
  package's record.
- Archiving reads every byte twice, once to hash the source and once to verify the stored copy.
  For a large render that is real I/O. It is accepted: the alternative is a receipt that asserts
  custody nobody checked, immediately before a cleanup that trusts it.

## Alternatives considered

- **Path scheme `<episodeId>/<runId>/<filename>`.** Rejected: it prevents the specific
  cross-Episode collision §8.1 names, but not a collision between two Runs of one Episode, nor
  between two stages of one Run. Content addressing prevents all of them with less machinery, and
  does not embed identity in a path — which §8.1 forbids.
- **Trusting a caller-supplied digest instead of hashing.** Rejected: §8.1 makes `sha256` half of
  an artifact's identity and §13 binds approvals to it, so a stale or buggy caller value would
  bind an approval to bytes nobody reviewed.
- **Archiving everything, not just `irreplaceable` artifacts.** Rejected: it would store bytes a
  re-run regenerates, and the resulting archive growth would push operators toward disabling
  archival altogether — losing the artifacts that actually needed it.
- **`executeCleanup` skipping blocked entries.** Rejected: see decision 5.
- **Widening `ArtifactRef` in Core with provenance fields.** Rejected for now: see decision 6. It
  is the natural resolution if provenance turns out to be shared across implementations.
- **Moving all storage ports to Core now.** Rejected: see decision 7.
