/**
 * Lineage queries.
 *
 * Contract §20 requires production trace to answer "which inputs, code, packs, and configuration
 * were used" and "which artifact became canonical". Contract §8.1 supplies the edges: every
 * artifact declares `inputHashes`, and records `producerRunId` and `producerStageId`.
 *
 * Edges are **digests, not IDs**. That is what makes lineage survive re-registration: if the same
 * bytes are registered again under a new ID in a different Run, anything derived from those bytes
 * is still correctly attributed, because the derivation named the content rather than a record.
 * It also means one digest may resolve to several records, which the return shapes admit rather
 * than collapse.
 *
 * Every traversal is cycle-safe. A cycle cannot arise from honest content addressing — deriving A
 * from B and B from A would require knowing a digest before producing the bytes — but a
 * hand-edited or corrupted index can express one, and a query that hangs on bad data is worse
 * than one that reports it. Cycles are returned in the result rather than thrown, because a
 * caller asking "where did this come from" needs the partial answer plus the warning, not an
 * exception instead of both.
 */

import type { ArtifactRecord } from "./record.js";

/**
 * One node reached during traversal: either a registered record, or a digest that was declared
 * as an input but which no registered artifact has.
 */
type LineageStep = ArtifactRecord | { unresolved: string };

/** One step away from an artifact, in either direction. */
export interface LineageEdge {
  /** Digest of the artifact the edge points at. */
  sha256: string;
  /** Records holding that digest. Empty when the input was never registered. */
  records: ArtifactRecord[];
}

/** The result of a transitive traversal. */
export interface LineageResult {
  /** Records reached, nearest first, excluding the starting artifact. */
  records: ArtifactRecord[];
  /**
   * Digests referenced as inputs that no registered artifact has.
   *
   * Contract §8.1 requires every stage to declare its inputs, so an unresolved digest means an
   * input was consumed that the registry never saw — worth surfacing rather than silently
   * pruning from the graph.
   */
  unresolvedDigests: string[];
  /** Artifact IDs at which traversal revisited a node, i.e. a cycle in recorded edges. */
  cycles: string[];
}

/** What produced an artifact (contract §8.1). */
export interface ProducerInfo {
  runId: string;
  stageId: string;
  /** Code revision recorded at production time, if the producer supplied one. */
  codeRevision: string | undefined;
  /** Digest of the configuration used, if the producer supplied one. */
  configHash: string | undefined;
}

/**
 * An index over records, built once per query batch.
 *
 * Lineage traversal looks up by digest repeatedly; doing that with a linear scan makes ancestry
 * quadratic in the size of the registry.
 */
export class LineageGraph {
  readonly #byId = new Map<string, ArtifactRecord>();
  readonly #byDigest = new Map<string, ArtifactRecord[]>();
  readonly #consumersOfDigest = new Map<string, ArtifactRecord[]>();

  constructor(records: readonly ArtifactRecord[]) {
    for (const record of records) {
      this.#byId.set(record.artifact.artifactId, record);

      const sameDigest = this.#byDigest.get(record.artifact.sha256);
      if (sameDigest === undefined) this.#byDigest.set(record.artifact.sha256, [record]);
      else sameDigest.push(record);

      // De-duplicated: an artifact that declares the same input twice is one consumer, not two.
      for (const input of new Set(record.artifact.inputHashes)) {
        const consumers = this.#consumersOfDigest.get(input);
        if (consumers === undefined) this.#consumersOfDigest.set(input, [record]);
        else consumers.push(record);
      }
    }
  }

  /** Every record in the graph. */
  records(): ArtifactRecord[] {
    return [...this.#byId.values()];
  }

  /** One record by ID. */
  get(artifactId: string): ArtifactRecord | undefined {
    return this.#byId.get(artifactId);
  }

  /** Records holding a digest. */
  byDigest(sha256: string): ArtifactRecord[] {
    return this.#byDigest.get(sha256) ?? [];
  }

  /** What produced an artifact (contract §8.1). */
  producerOf(artifactId: string): ProducerInfo | undefined {
    const record = this.#byId.get(artifactId);
    if (record === undefined) return undefined;
    return {
      runId: record.artifact.producerRunId,
      stageId: record.artifact.producerStageId,
      codeRevision: record.provenance.codeRevision,
      configHash: record.provenance.configHash,
    };
  }

  /** Immediate inputs of an artifact, one edge per declared digest. */
  inputsOf(artifactId: string): LineageEdge[] {
    const record = this.#byId.get(artifactId);
    if (record === undefined) return [];
    return [...new Set(record.artifact.inputHashes)].map((sha256) => ({
      sha256,
      records: this.byDigest(sha256),
    }));
  }

  /** Artifacts directly derived from this one. */
  consumersOf(artifactId: string): ArtifactRecord[] {
    const record = this.#byId.get(artifactId);
    if (record === undefined) return [];
    return this.#consumersOfDigest.get(record.artifact.sha256) ?? [];
  }

  /**
   * Everything this artifact was transitively derived from, nearest first.
   *
   * Breadth-first so that "nearest first" is true, which is what an operator reading a trace
   * wants: the direct inputs, then theirs.
   */
  ancestorsOf(artifactId: string): LineageResult {
    return this.#traverse(artifactId, (record) =>
      [...new Set(record.artifact.inputHashes)].flatMap<LineageStep>((digest) => {
        const found = this.byDigest(digest);
        return found.length > 0 ? found : [{ unresolved: digest }];
      }),
    );
  }

  /** Everything transitively derived from this artifact, nearest first. */
  descendantsOf(artifactId: string): LineageResult {
    return this.#traverse(artifactId, (record) => this.consumersOf(record.artifact.artifactId));
  }

  /**
   * Shared traversal: breadth-first for ordering, with a separate depth-first pass for cycles.
   *
   * The two are separate deliberately. Breadth-first visit tracking terminates on a cycle, but
   * it cannot *identify* one: a node reached twice is just as likely to be a diamond — B and C
   * both derived from A, D derived from both — which is ordinary, correct lineage. Reporting a
   * diamond as a cycle would train an operator to ignore the field. A cycle is specifically a
   * node reachable from itself, which is what the depth-first pass tests.
   */
  #traverse(artifactId: string, step: (record: ArtifactRecord) => LineageStep[]): LineageResult {
    const start = this.#byId.get(artifactId);
    if (start === undefined) return { records: [], unresolvedDigests: [], cycles: [] };

    const visited = new Set<string>([artifactId]);
    const records: ArtifactRecord[] = [];
    const unresolved = new Set<string>();

    let frontier: ArtifactRecord[] = [start];
    while (frontier.length > 0) {
      const next: ArtifactRecord[] = [];
      for (const record of frontier) {
        for (const neighbour of step(record)) {
          if ("unresolved" in neighbour) {
            unresolved.add(neighbour.unresolved);
            continue;
          }
          const id = neighbour.artifact.artifactId;
          // Already seen: a diamond, or a cycle. Either way there is nothing new below it.
          if (visited.has(id)) continue;
          visited.add(id);
          records.push(neighbour);
          next.push(neighbour);
        }
      }
      frontier = next;
    }

    return {
      records,
      unresolvedDigests: [...unresolved],
      cycles: this.#findCycles(start, records, step),
    };
  }

  /**
   * IDs that lie on a cycle within the reached subgraph.
   *
   * Standard three-colour depth-first search: a node is grey while it is on the current path, so
   * an edge into a grey node is an edge back into the path — a genuine cycle. An edge into a
   * black (finished) node is a diamond and is ignored.
   */
  #findCycles(
    start: ArtifactRecord,
    reached: readonly ArtifactRecord[],
    step: (record: ArtifactRecord) => LineageStep[],
  ): string[] {
    const onPath = new Set<string>();
    const finished = new Set<string>();
    const cycles = new Set<string>();

    const visit = (record: ArtifactRecord): void => {
      const id = record.artifact.artifactId;
      if (finished.has(id)) return;
      if (onPath.has(id)) {
        cycles.add(id);
        return;
      }
      onPath.add(id);
      for (const neighbour of step(record)) {
        if (!("unresolved" in neighbour)) visit(neighbour);
      }
      onPath.delete(id);
      finished.add(id);
    };

    for (const record of [start, ...reached]) visit(record);
    return [...cycles];
  }
}
