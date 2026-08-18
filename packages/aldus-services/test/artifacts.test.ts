/**
 * Registry-backed artifact services (contract §8, §8.1, §20).
 *
 * Before this wiring, `services.artifacts()` read §7's `artifacts.json` and nothing an operator
 * could reach knew about provenance, archival state, lineage, or whether a cleanup was safe. These
 * tests are about what the collection file could never answer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "@aldus-runtime/core";
import type { ArtifactRef } from "@aldus-runtime/core";

import { ServiceErrorCodes } from "../src/errors.js";
import {
  makeComposedServices,
  seedRun,
  writeWorkingFile,
  RUN_ID,
  type Harness,
} from "./composition-helpers.js";
import { makeTempWorkspace, OPERATOR, type TempWorkspace } from "./helpers.js";

let workspace: TempWorkspace;
let harness: Harness;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
  harness = makeComposedServices(workspace.workspace, {});
  await seedRun(harness.services);
});

afterEach(async () => {
  await workspace.cleanup();
});

/** Register an artifact through the registry the context owns. */
async function register(options: {
  name: string;
  contents: string;
  reconstructability: "source" | "reproducible" | "irreplaceable";
  inputHashes?: string[];
  stageId?: string;
}): Promise<string> {
  const path = await writeWorkingFile(workspace.root, `working/${options.name}`, options.contents);
  const record = await harness.context.artifacts.register({
    path,
    kind: "audio",
    mediaType: "audio/wav",
    producerRunId: RUN_ID,
    producerStageId: options.stageId ?? "stage-a",
    reconstructability: options.reconstructability,
    ...(options.inputHashes === undefined ? {} : { inputHashes: options.inputHashes }),
    provenance: { codeRevision: "revision-a" },
  });
  return record.artifact.artifactId;
}

describe("artifacts (contract §8)", () => {
  it("reports registry records with provenance the collection file cannot carry", async () => {
    await register({ name: "take.wav", contents: "audio a", reconstructability: "irreplaceable" });

    const result = await harness.services.artifacts(RUN_ID);

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.records).toHaveLength(1);
    // §8.1: an artifact records which stage, run, and code revision produced it.
    expect(result.data.records[0]?.provenance.codeRevision).toBe("revision-a");
    expect(result.data.records[0]?.artifact.producerStageId).toBe("stage-a");
  });

  it("names irreplaceable artifacts that are not yet archived (§8.1)", async () => {
    await register({ name: "take.wav", contents: "audio a", reconstructability: "irreplaceable" });
    await register({ name: "mix.wav", contents: "audio b", reconstructability: "reproducible" });

    const result = await harness.services.artifacts(RUN_ID);

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    // Only the irreplaceable one: §8.1 requires archival before cleanup for exactly that class.
    expect(result.data.unarchivedIrreplaceable).toHaveLength(1);
    expect(result.data.unarchivedIrreplaceable[0]?.artifact.reconstructability).toBe(
      "irreplaceable",
    );
  });

  it("reports a collection entry the registry never saw, rather than presenting it as registered", async () => {
    // A Run produced before the registry existed. Merging it would claim provenance and archival
    // state nobody collected; §3.4 makes the durable record authoritative, so it is reported apart.
    const legacy: ArtifactRef = {
      schemaVersion: SCHEMA_VERSION,
      artifactId: "art-legacy",
      kind: "audio",
      uri: "file:///legacy/req-00.wav",
      sha256: "e".repeat(64),
      mediaType: "audio/wav",
      producerRunId: RUN_ID,
      producerStageId: "stage-legacy",
      inputHashes: [],
      reconstructability: "irreplaceable",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await workspace.workspace.runs.addRecord(RUN_ID, "artifacts", legacy);

    const result = await harness.services.artifacts(RUN_ID);

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.records).toHaveLength(0);
    expect(result.data.unregistered.map((entry) => entry.artifactId)).toEqual(["art-legacy"]);
  });
});

describe("lineage (contract §20)", () => {
  it("answers what produced an artifact and what was derived from it", async () => {
    const sourceId = await register({
      name: "source.wav",
      contents: "audio source",
      reconstructability: "source",
      stageId: "stage-source",
    });
    const source = await harness.context.artifacts.require(sourceId);
    const derivedId = await register({
      name: "derived.wav",
      contents: "audio derived",
      reconstructability: "reproducible",
      inputHashes: [source.artifact.sha256],
      stageId: "stage-derive",
    });

    const upstream = await harness.services.artifactLineage(derivedId);
    expect(upstream.outcome).toBe("ok");
    if (upstream.outcome !== "ok") return;
    expect(upstream.data.producer?.stageId).toBe("stage-derive");
    expect(upstream.data.ancestors.records.map((r) => r.artifact.artifactId)).toEqual([sourceId]);

    const downstream = await harness.services.artifactLineage(sourceId);
    if (downstream.outcome !== "ok") return;
    expect(downstream.data.consumers.map((r) => r.artifact.artifactId)).toEqual([derivedId]);
  });

  it("throws for an artifact the registry does not hold", async () => {
    await expect(harness.services.artifactLineage("art-absent")).rejects.toMatchObject({
      code: ServiceErrorCodes.ARTIFACT_NOT_REGISTERED,
    });
  });
});

describe("cleanup planning (contract §8.1)", () => {
  it("refuses to clear an unarchived irreplaceable artifact", async () => {
    await register({ name: "take.wav", contents: "audio a", reconstructability: "irreplaceable" });

    const plan = await harness.services.planArtifactCleanup(RUN_ID);

    expect(plan.outcome).toBe("ok");
    if (plan.outcome !== "ok") return;
    // §8.1's ordering is the whole point: archive first, clean second.
    expect(plan.data.safe).toBe(false);
    expect(plan.data.blocked).toHaveLength(1);
    expect(plan.data.blocked[0]?.reason).toBe("unarchived-irreplaceable");
  });

  it("clears the same artifact once it has been archived", async () => {
    await register({ name: "take.wav", contents: "audio a", reconstructability: "irreplaceable" });

    const archived = await harness.services.archiveIrreplaceable({
      runId: RUN_ID,
      actor: OPERATOR,
    });
    expect(archived.outcome).toBe("ok");
    if (archived.outcome !== "ok") return;
    expect(archived.data.archived).toHaveLength(1);

    const plan = await harness.services.planArtifactCleanup(RUN_ID);
    if (plan.outcome !== "ok") return;
    expect(plan.data.safe).toBe(true);
    expect(plan.data.removable).toHaveLength(1);
  });

  it("plans without an actor, because deciding whether a cleanup is safe is a read", async () => {
    await register({ name: "take.wav", contents: "audio a", reconstructability: "reproducible" });
    const plan = await harness.services.planArtifactCleanup(RUN_ID);
    expect(plan.outcome).toBe("ok");
  });

  it("refuses an anonymous archive, because archiving mutates (§19.2)", async () => {
    const anonymous = makeComposedServices(workspace.workspace, { actor: null });
    await expect(anonymous.services.archiveIrreplaceable({ runId: RUN_ID })).rejects.toMatchObject({
      code: ServiceErrorCodes.ACTOR_REQUIRED,
    });
  });

  it("is idempotent, reporting an already-archived artifact as such", async () => {
    await register({ name: "take.wav", contents: "audio a", reconstructability: "irreplaceable" });
    await harness.services.archiveIrreplaceable({ runId: RUN_ID, actor: OPERATOR });

    const again = await harness.services.archiveIrreplaceable({ runId: RUN_ID, actor: OPERATOR });

    expect(again.outcome).toBe("ok");
    if (again.outcome !== "ok") return;
    expect(again.data.archived).toHaveLength(0);
    expect(again.data.alreadyArchived).toHaveLength(1);
  });
});
