/**
 * Lineage queries (contract §8.1, §20).
 *
 * Production trace must answer what produced an artifact, what was derived from it, and what it
 * descends from. Edges are digests rather than IDs, which is what these tests pin — along with
 * the two things a graph traversal gets wrong if nobody checks: a diamond misreported as a
 * cycle, and a real cycle that hangs the query.
 */

import { describe, expect, it } from "vitest";

import { LineageGraph } from "../src/lineage.js";
import type { ArtifactRecord } from "../src/record.js";

/** A digest built from a label, so tests read as a graph rather than as hex. */
function digest(label: string): string {
  return label
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");
}

function record(
  id: string,
  sha: string,
  inputs: string[],
  overrides: Partial<ArtifactRecord["artifact"]> = {},
): ArtifactRecord {
  return {
    schemaVersion: "1.2",
    artifact: {
      schemaVersion: "1.2",
      artifactId: id,
      kind: "kind-a",
      uri: `file:///tmp/${id}`,
      sha256: sha,
      mediaType: "application/octet-stream",
      producerRunId: "run-a",
      producerStageId: "stage-a",
      inputHashes: inputs,
      reconstructability: "reproducible",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
    provenance: {},
    registeredAt: "2026-01-01T00:00:00.000Z",
  };
}

const shaA = digest("aaa1");
const shaB = digest("bbb2");
const shaC = digest("ccc3");
const shaD = digest("ddd4");

/** A → B → C, a simple chain. */
const chain = new LineageGraph([
  record("art-a", shaA, []),
  record("art-b", shaB, [shaA]),
  record("art-c", shaC, [shaB]),
]);

describe("producerOf", () => {
  it("reports the run, stage, code revision, and configuration (contract §8.1)", () => {
    const graph = new LineageGraph([
      {
        ...record("art-a", shaA, [], { producerRunId: "run-x", producerStageId: "stage-y" }),
        provenance: { codeRevision: "revision-a", configHash: digest("cfg") },
      },
    ]);
    expect(graph.producerOf("art-a")).toEqual({
      runId: "run-x",
      stageId: "stage-y",
      codeRevision: "revision-a",
      configHash: digest("cfg"),
    });
  });

  it("returns undefined for an unregistered artifact", () => {
    expect(chain.producerOf("art-missing")).toBeUndefined();
  });
});

describe("direct edges", () => {
  it("resolves immediate inputs by digest", () => {
    const inputs = chain.inputsOf("art-b");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.sha256).toBe(shaA);
    expect(inputs[0]?.records.map((entry) => entry.artifact.artifactId)).toEqual(["art-a"]);
  });

  it("reports an input digest that no registered artifact has", () => {
    const graph = new LineageGraph([record("art-b", shaB, [digest("unknown")])]);
    expect(graph.inputsOf("art-b")[0]?.records).toEqual([]);
  });

  it("finds artifacts directly derived from one", () => {
    expect(chain.consumersOf("art-a").map((entry) => entry.artifact.artifactId)).toEqual(["art-b"]);
  });

  it("attributes derivation to every record sharing the input digest", () => {
    // Edges are digests, so re-registering the same bytes under a new ID keeps the derivation
    // correctly attributed to both records.
    const graph = new LineageGraph([
      record("art-a1", shaA, []),
      record("art-a2", shaA, []),
      record("art-b", shaB, [shaA]),
    ]);
    expect(graph.inputsOf("art-b")[0]?.records).toHaveLength(2);
  });

  it("counts an artifact that declares the same input twice as one consumer", () => {
    const graph = new LineageGraph([
      record("art-a", shaA, []),
      record("art-b", shaB, [shaA, shaA]),
    ]);
    expect(graph.consumersOf("art-a")).toHaveLength(1);
  });
});

describe("ancestorsOf", () => {
  it("walks the full chain, nearest first", () => {
    expect(chain.ancestorsOf("art-c").records.map((entry) => entry.artifact.artifactId)).toEqual([
      "art-b",
      "art-a",
    ]);
  });

  it("excludes the starting artifact", () => {
    expect(
      chain.ancestorsOf("art-c").records.some((entry) => entry.artifact.artifactId === "art-c"),
    ).toBe(false);
  });

  it("reports unresolved input digests rather than pruning them silently", () => {
    const missing = digest("fade");
    const graph = new LineageGraph([record("art-b", shaB, [missing])]);
    expect(graph.ancestorsOf("art-b").unresolvedDigests).toEqual([missing]);
  });

  it("returns an empty result for an unregistered artifact", () => {
    expect(chain.ancestorsOf("art-missing")).toEqual({
      records: [],
      unresolvedDigests: [],
      cycles: [],
    });
  });
});

describe("descendantsOf", () => {
  it("walks forward through the chain", () => {
    expect(chain.descendantsOf("art-a").records.map((entry) => entry.artifact.artifactId)).toEqual([
      "art-b",
      "art-c",
    ]);
  });
});

describe("diamonds and cycles", () => {
  // B and C both derive from A; D derives from both. Ordinary, correct lineage.
  const diamond = new LineageGraph([
    record("art-a", shaA, []),
    record("art-b", shaB, [shaA]),
    record("art-c", shaC, [shaA]),
    record("art-d", shaD, [shaB, shaC]),
  ]);

  it("reaches a shared ancestor exactly once", () => {
    const ancestors = diamond.ancestorsOf("art-d");
    expect(ancestors.records.map((entry) => entry.artifact.artifactId).sort()).toEqual([
      "art-a",
      "art-b",
      "art-c",
    ]);
  });

  it("does NOT report a diamond as a cycle", () => {
    // The distinction that keeps the field meaningful. A node reached twice is usually a
    // diamond; calling it a cycle would train an operator to ignore the warning.
    expect(diamond.ancestorsOf("art-d").cycles).toEqual([]);
    expect(diamond.descendantsOf("art-a").cycles).toEqual([]);
  });

  it("terminates on a cycle instead of hanging, and names it", () => {
    // Impossible from honest content addressing — deriving A from B and B from A would require
    // knowing a digest before producing the bytes — but a hand-edited index can express it, and
    // a query that never returns is worse than one that reports the corruption.
    const cyclic = new LineageGraph([record("art-a", shaA, [shaB]), record("art-b", shaB, [shaA])]);

    const ancestors = cyclic.ancestorsOf("art-a");
    expect(ancestors.records.map((entry) => entry.artifact.artifactId)).toEqual(["art-b"]);
    expect(ancestors.cycles.length).toBeGreaterThan(0);

    const descendants = cyclic.descendantsOf("art-a");
    expect(descendants.cycles.length).toBeGreaterThan(0);
  });

  it("terminates on a self-referential artifact", () => {
    const selfCycle = new LineageGraph([record("art-a", shaA, [shaA])]);
    expect(selfCycle.ancestorsOf("art-a").cycles).toContain("art-a");
  });

  it("terminates on a longer cycle", () => {
    const long = new LineageGraph([
      record("art-a", shaA, [shaC]),
      record("art-b", shaB, [shaA]),
      record("art-c", shaC, [shaB]),
    ]);
    expect(long.ancestorsOf("art-a").cycles.length).toBeGreaterThan(0);
    expect(long.ancestorsOf("art-a").records).toHaveLength(2);
  });
});
