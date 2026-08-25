/**
 * Registering artifacts on a stage's behalf (contract §8.1, ADR-0027).
 *
 * `@aldus-runtime/stage-runner` declares an `ArtifactRecorder` port so a stage can register a
 * produced file without reaching for a registry it cannot obtain until its own context exists.
 * This is the adapter that satisfies it.
 *
 * The shape below is **structurally** compatible with that port and deliberately does not import
 * it. A registry importing the runner would invert the layering — the registry is the lower
 * layer, and §7 keeps storage independent of the components above it. Structural typing is what
 * lets the two meet without either depending on the other; whoever composes them wires it up
 * (ADR-0015).
 */

import type { ArtifactRef, Reconstructability } from "@aldus-runtime/core";

import type { ArtifactProvenance } from "./record.js";
import type { ArtifactRegistry } from "./registry.js";

/**
 * Provenance a stage supplies for itself.
 *
 * Everything §8.1 names — run, stage, code revision, configuration — is absent, because the
 * runner fills those from the attempt.
 */
export interface StageSuppliedProvenance {
  /** Provider seed, recorded for trace only (contract §8.1). */
  providerSeed?: string;
  /** Knowledge Packs in force when the artifact was produced (contract §20). */
  knowledgePackIds?: readonly string[];
  /** Free-text note, already redacted (contract §19.2). */
  note?: string;
}

/**
 * What the stage runner hands over for one produced file.
 *
 * Mirrors `ArtifactRecorderRequest` in `@aldus-runtime/stage-runner`. The duplication is the
 * price of not depending on it, and it is checked: a type-level compatibility test asserts the
 * two stay assignable, so a drift between them fails to compile rather than at runtime.
 */
export interface StageArtifactRequest {
  /** Path to the produced bytes. Hashed and sized here, never trusted from the caller. */
  path: string;
  /** What kind of artifact this is (contract §8.2). */
  kind: string;
  /** IANA media type of the bytes. */
  mediaType: string;
  /** How recoverable it is (contract §8). */
  reconstructability: Reconstructability;
  /** Digests of the inputs it was derived from (contract §8.1). */
  inputHashes?: readonly string[];
  /** Provenance the attempt cannot know. */
  provenance?: StageSuppliedProvenance;
  /** Artifact ID to use. Defaults to a freshly minted one. */
  artifactId?: string;
  /** URI recorded as the artifact's location. */
  uri?: string;
  /** Run that produced it, supplied by the runner (contract §8.1). */
  producerRunId: string;
  /** Stage that produced it, supplied by the runner (contract §8.1). */
  producerStageId: string;
  /**
   * What produced the bytes — an agent backend and its model, a renderer and its version.
   *
   * Optional here because requiring it would break every existing caller, and a stage that has
   * nothing truthful to say should not be forced to invent something. **Absent means unrecorded,
   * not absent-producer** — `producerProvenanceGap` reports it.
   *
   * @see ArtifactRef.producers
   */
  producers?: ArtifactRef["producers"];
  /** Revision of the runtime code, from the Run manifest (contract §8.1, §20). */
  codeRevision?: string;
  /** Digest of the configuration the attempt ran under (contract §11, §20). */
  configHash: string;
  /** The attempt's configuration, already redacted (contract §19.2). */
  configuration?: Record<string, unknown>;
}

/** Satisfies `ArtifactRecorder` from `@aldus-runtime/stage-runner`. */
export interface StageArtifactRecorder {
  register(request: StageArtifactRequest): Promise<ArtifactRef>;
}

/**
 * Adapt a registry into the recorder a stage runner expects.
 *
 * The digest is not passed through: {@link ArtifactRegistry.register} computes it from the bytes,
 * because §8.1 makes it half of an artifact's identity and §13 binds approvals to it.
 *
 * **This is what to pass as a `StageRunner`'s `artifacts` option**, including in a test that wants
 * a runner behaving like the composed stack's. `@aldus-runtime/services` uses it internally and
 * does not re-export it, which led an adopter to conclude it was internal and hand-write a
 * substitute rather than drive a real runner. It is public, from here.
 *
 * Worth the hand-written substitute being avoidable: a stub that satisfies the runner lets a stage
 * "record" an artifact nowhere while every assertion in the test still passes.
 */
export function stageArtifactRecorder(registry: ArtifactRegistry): StageArtifactRecorder {
  return {
    async register(request: StageArtifactRequest): Promise<ArtifactRef> {
      const extras = request.provenance ?? {};
      const provenance: ArtifactProvenance = {
        // The runner's values, not the stage's. A stage has no field to state these in, so an
        // artifact attributed to the wrong attempt is unrepresentable rather than merely
        // discouraged (contract §8.1).
        ...(request.codeRevision === undefined ? {} : { codeRevision: request.codeRevision }),
        configHash: request.configHash,
        ...(request.configuration === undefined ? {} : { configuration: request.configuration }),
        ...(extras.providerSeed === undefined ? {} : { providerSeed: extras.providerSeed }),
        ...(extras.knowledgePackIds === undefined
          ? {}
          : { knowledgePackIds: [...extras.knowledgePackIds] }),
        ...(extras.note === undefined ? {} : { note: extras.note }),
      };

      const record = await registry.register({
        path: request.path,
        kind: request.kind,
        mediaType: request.mediaType,
        reconstructability: request.reconstructability,
        producerRunId: request.producerRunId,
        producerStageId: request.producerStageId,
        ...(request.producers === undefined ? {} : { producers: request.producers }),
        ...(request.inputHashes === undefined ? {} : { inputHashes: [...request.inputHashes] }),
        ...(request.artifactId === undefined ? {} : { artifactId: request.artifactId }),
        ...(request.uri === undefined ? {} : { uri: request.uri }),
        provenance,
      });

      return record.artifact;
    },
  };
}
