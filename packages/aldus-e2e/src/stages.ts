/**
 * Stage definitions for the composed journey (architecture contract §11).
 *
 * Stages belong to adopters (§4.2, §11), so these are what an adopter's stages look like from the
 * runtime's side. Two things about their shape are worth noticing, because both are consequences
 * of the contract rather than conveniences:
 *
 * - A stage that produces an artifact **closes over the registry**. `StageContext` gives a stage
 *   `recordOutput`, which records an `ArtifactRef` onto the attempt, but registration — hashing
 *   the bytes, recording provenance, and taking archival custody (§8) — is the registry's job and
 *   the registry is not on the context. So the adopter wires it, exactly as ADR-0015 says.
 * - A stage that needs a decision returns `gate_required` rather than throwing. §11 requires a
 *   stage to "stop at required gates", and a halt is an ordinary outcome, not a failure.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactRegistry } from "@aldus-runtime/artifact-registry";
import type { StageDefinition, StageOutcome } from "@aldus-runtime/stage-runner";

/** A schema accepting anything, for stages whose payload is not what is under test. */
const anySchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };

/** What {@link producingStage} needs to write and register its output. */
export interface ProducingStageOptions {
  /** Where working files are written. */
  workingRoot: string;
  /** Path of the produced file, relative to `workingRoot`. */
  relativePath: string;
  /** Bytes to write. Deliberately caller-supplied so two Episodes can produce different audio. */
  contents: string;
  /** Artifact kind (contract §8.2). Open string; Core names no taxonomy. */
  kind: string;
  /** IANA media type. */
  mediaType: string;
  /** How recoverable the output is (contract §8). */
  reconstructability: "source" | "reproducible" | "irreplaceable";
  /** The registry the adopter wired in. */
  registry: ArtifactRegistry;
}

/**
 * A stage that writes a file and registers it as an artifact.
 *
 * Registration happens inside `execute` and `recordOutput` is called immediately after, so a stage
 * that later failed would still leave the artifact recorded and attributable — §19.1's "recovery
 * from partial success" is only real if outputs are recorded as they appear.
 */
export function producingStage(
  id: string,
  options: ProducingStageOptions,
  version = "1",
): StageDefinition<unknown, unknown> {
  return {
    id,
    version,
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    // One, of the kind it registers. It registers through the registry directly rather than
    // through `context.registerOutput`, and the attempt records it either way — so declaring
    // "none" here made the artifact undeclared and the stage failed its own contract. That is
    // the check working: the declaration has to describe what the stage does, not which API it
    // used to do it.
    artifacts: {
      produces: "declared",
      resolve: () => [{ kind: options.kind, minCount: 1, maxCount: 1 }],
    },
    retrySafety: { kind: "no_external_effects" },
    execute: async (context): Promise<StageOutcome<unknown>> => {
      const path = join(options.workingRoot, options.relativePath);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, options.contents, "utf8");

      const record = await options.registry.register({
        path,
        kind: options.kind,
        mediaType: options.mediaType,
        producerRunId: context.runId,
        producerStageId: context.stageId,
        reconstructability: options.reconstructability,
        provenance: {
          codeRevision: "revision-a",
          // §8.1 requires an artifact to record which stage, run, code revision, *and
          // configuration* produced it. The runner already digests the configuration for the
          // attempt, so passing that digest through keeps the artifact and the attempt agreeing
          // on one value rather than hashing the same thing twice.
          configHash: context.configurationHash,
        },
      });
      context.recordOutput(record.artifact);
      context.note("Registered the produced artifact.", {
        artifactId: record.artifact.artifactId,
      });
      return { kind: "completed", output: { artifactId: record.artifact.artifactId } };
    },
  };
}

/**
 * A stage that halts at a gate (contract §11, §13).
 *
 * `subjectHashes` is what the eventual decision binds, recorded at the moment the stage saw them
 * so that a later change to those inputs invalidates the approval (§13.1).
 */
export function gatedStage(
  id: string,
  gateId: string,
  subjectHashes: string[] = [],
  version = "1",
): StageDefinition<unknown, unknown> {
  return {
    id,
    version,
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" },
    execute: (): Promise<StageOutcome<unknown>> =>
      Promise.resolve({
        kind: "gate_required",
        gateId,
        subjectHashes,
        reason: "The spoken content must be frozen before anything downstream may proceed.",
      }),
  };
}

/** Options for {@link selfRegisteringStage}. */
export interface SelfRegisteringStageOptions {
  workingRoot: string;
  relativePath: string;
  contents: string;
  kind: string;
  mediaType: string;
  reconstructability: "source" | "reproducible" | "irreplaceable";
}

/**
 * A stage that registers its output through `context.registerOutput` rather than a closed-over
 * registry (#39, ADR-0027).
 *
 * The distinction from {@link producingStage} is the whole point: this one names only what a
 * stage knows — the path, kind, media type and reconstructability — and the runner supplies
 * `producerRunId`, `producerStageId`, the code revision, the configuration digest and the sha256.
 * A stage therefore cannot register an artifact whose provenance disagrees with the attempt that
 * produced it, because the registration type has no field to write it in.
 *
 * It exists here because the closure form is what every other stage in this package uses, and a
 * capability nothing exercises is a capability nobody notices is unwired: `registerOutput`
 * refused for every stage the services ran, while all of these tests passed (#67).
 */
export function selfRegisteringStage(
  id: string,
  options: SelfRegisteringStageOptions,
  version = "1",
): StageDefinition<unknown, unknown> {
  return {
    id,
    version,
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    // Exactly one, of the kind it registers. Written from what the stage does rather than
    // from what it happened to produce — which is ADR-0040's whole constraint.
    artifacts: {
      produces: "declared",
      resolve: () => [{ kind: options.kind, minCount: 1, maxCount: 1 }],
    },
    retrySafety: { kind: "no_external_effects" },
    execute: async (context): Promise<StageOutcome<unknown>> => {
      const path = join(options.workingRoot, options.relativePath);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, options.contents, "utf8");

      const artifact = await context.registerOutput({
        path,
        kind: options.kind,
        mediaType: options.mediaType,
        reconstructability: options.reconstructability,
      });

      context.note("Registered through the stage context.", { artifactId: artifact.artifactId });
      return { kind: "completed", output: { artifactId: artifact.artifactId } };
    },
  };
}
