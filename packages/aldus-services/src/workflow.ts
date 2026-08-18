/**
 * The workflow graph: which gates gate which stages (architecture contract §11).
 *
 * §11 calls a workflow "a versioned graph of stages and gates", and §11 makes that graph
 * adopter-supplied. §4.2 keeps adopter workflows out of the runtime, so Aldus does not define
 * one — it accepts one, and uses it to answer a question it could not previously answer: when an
 * operator asks what is safe to do next, *which* gates are actually standing in the way of
 * *which* stages.
 *
 * Without this, the next-action policy had only one honest answer available: if any blocking gate
 * is unsatisfied, treat every unrun stage as blocked. That is safe, and it is also close to
 * useless once a realistic workflow declares its gates up front — which is exactly what §11
 * describes. ADR-0021 records the decision.
 *
 * `RunManifest` already carries `workflowId` and `workflowVersion`. This is the graph those two
 * fields name.
 */

/** One stage's place in the workflow graph (contract §11). */
export interface WorkflowStageNode {
  /** The stage this node describes. An open string — workflows belong to adopters (§4.2). */
  stageId: string;
  /**
   * Gates that must be satisfied before this stage should be offered.
   *
   * An empty array is meaningful and different from omitting the node: it says "this stage
   * requires no gate", which is a declaration. Omitting the stage from the graph declares
   * nothing, and is treated conservatively (ADR-0021).
   */
  requiredGates?: readonly string[];
  /**
   * Stages that must have **succeeded** before this one may run (contract §11).
   *
   * A data dependency, deliberately **not** an authorization. `requiredGates` says a human must
   * decide something; this says another stage must have produced something. Conflating the two
   * would force an adopter to invent a gate — and therefore a pointless approval — to express an
   * ordering constraint, and would make the gate's own meaning ("a human decided this") untrue.
   *
   * The two are orthogonal: a stage may declare one, both, or neither, and each produces its own
   * block reason.
   *
   * Absent means no ordering constraint. Unlike {@link WorkflowStageNode.requiredGates}, absence
   * needs no conservative reading: an edge only ever *adds* a precondition, so a missing one
   * cannot silently unblock work that a declared edge was protecting.
   */
  after?: readonly string[];
}

/**
 * A workflow's stage↔gate associations (contract §11).
 *
 * Supplied to `AldusContext`, alongside the gate and stage registries it already accepts. Aldus
 * owns composition and the adopter supplies the parts (ADR-0015); a workflow graph is a part.
 */
export interface WorkflowGraph {
  /**
   * Identity of the workflow this graph describes.
   *
   * Optional and unenforced. Recorded for an adopter's benefit — the services do not refuse a
   * graph whose id differs from a Run's `workflowId`, because a caller wiring one context per
   * workflow is the ordinary case and demanding the id match would be ceremony.
   */
  workflowId?: string;
  /** Version of this graph, for the same reason. */
  workflowVersion?: string;
  /** Stage nodes. A stage absent from this list is undeclared, not unblocked. */
  stages: readonly WorkflowStageNode[];
}

/** What a lookup of one stage's required gates can conclude. */
export type RequiredGatesResolution =
  /** Some source declared this stage's gates. The list may be empty, meaning "requires none". */
  | { declared: true; gates: readonly string[]; source: "workflow" | "stage-definition" }
  /** No source named this stage. Not the same as "requires nothing" — see ADR-0021. */
  | { declared: false };

/**
 * Resolve the gates one stage requires.
 *
 * Precedence is **graph over stage definition**, and the reason is reuse: one stage definition may
 * be used by several workflows that gate it differently, and a workflow must be able to say so
 * without editing a definition it shares. Union was the alternative and is worse, because it
 * makes a requirement impossible to *remove* for a single workflow.
 *
 * @param stageId Stage to resolve.
 * @param graph The workflow graph, if one was supplied.
 * @param definitionGates The stage definition's own declaration, if it made one.
 */
export function resolveRequiredGates(
  stageId: string,
  graph: WorkflowGraph | undefined,
  definitionGates: readonly string[] | undefined,
): RequiredGatesResolution {
  const node = graph?.stages.find((entry) => entry.stageId === stageId);
  if (node !== undefined && node.requiredGates !== undefined) {
    return { declared: true, gates: node.requiredGates, source: "workflow" };
  }
  if (definitionGates !== undefined) {
    return { declared: true, gates: definitionGates, source: "stage-definition" };
  }
  return { declared: false };
}

/**
 * Stages that must succeed before `stageId` may run (contract §11, ADR-0028).
 *
 * Empty when the stage declares no ordering, or when no graph was supplied. Absence is not
 * treated conservatively — see {@link WorkflowStageNode.after} for why it does not need to be.
 */
export function predecessorsOf(
  stageId: string,
  graph: WorkflowGraph | undefined,
): readonly string[] {
  return graph?.stages.find((node) => node.stageId === stageId)?.after ?? [];
}

/** True when any node declares an edge, so there is ordering information to reason from. */
export function hasEdges(graph: WorkflowGraph | undefined): boolean {
  return graph?.stages.some((node) => (node.after?.length ?? 0) > 0) ?? false;
}

/**
 * Stages nothing else waits on (contract §11, ADR-0028).
 *
 * A terminal is a stage no other stage lists in its `after`: reaching it is the last thing the
 * graph describes. This is what makes a meaningful default for `goalStages` possible. Before
 * edges existed, "finished" could only default to *every* stage the graph named — wrong for any
 * workflow with a conditional stage, and the caveat ADR-0026 had to record.
 *
 * Empty when the graph declares no edges at all: every stage is then trivially terminal and the
 * answer would carry no information, so callers fall back to the older reading.
 */
export function terminalStagesOf(graph: WorkflowGraph | undefined): readonly string[] {
  if (graph === undefined || !hasEdges(graph)) return [];
  const waitedOn = new Set(graph.stages.flatMap((node) => node.after ?? []));
  return graph.stages.map((node) => node.stageId).filter((stageId) => !waitedOn.has(stageId));
}

/** A problem that makes a workflow graph unsatisfiable. */
export interface WorkflowGraphProblem {
  kind: "unknown-stage" | "cycle" | "duplicate-stage" | "self-edge";
  /** One sentence naming what is wrong and which stages are involved. */
  message: string;
  /** The stages implicated, in the order they form the problem. */
  stages: readonly string[];
}

/**
 * Everything wrong with a workflow graph, or an empty list (contract §11, ADR-0028).
 *
 * Checked where the graph is *resolved* rather than where it is written, so every consumer
 * benefits and not only the binary — ADR-0015 puts policy on Aldus's side of an injection point,
 * and a graph arrives through one.
 *
 * A graph that cannot be satisfied must fail loudly and early. The alternative is a Run that
 * wedges partway through with no stage runnable and nothing saying why, which is the failure mode
 * every ordering rule in this package exists to prevent.
 */
export function validateWorkflowGraph(graph: WorkflowGraph): readonly WorkflowGraphProblem[] {
  const problems: WorkflowGraphProblem[] = [];
  const known = new Set<string>();
  const duplicated = new Set<string>();

  for (const node of graph.stages) {
    if (known.has(node.stageId)) duplicated.add(node.stageId);
    known.add(node.stageId);
  }
  for (const stageId of duplicated) {
    problems.push({
      kind: "duplicate-stage",
      stages: [stageId],
      message:
        `Stage "${stageId}" appears more than once in the workflow graph. Resolving to the first ` +
        "would silently ignore the second, and which one was meant is not guessable.",
    });
  }

  for (const node of graph.stages) {
    for (const predecessor of node.after ?? []) {
      if (predecessor === node.stageId) {
        problems.push({
          kind: "self-edge",
          stages: [node.stageId],
          message: `Stage "${node.stageId}" is declared to run after itself, which can never be satisfied.`,
        });
        continue;
      }
      if (!known.has(predecessor)) {
        problems.push({
          kind: "unknown-stage",
          stages: [node.stageId, predecessor],
          message:
            `Stage "${node.stageId}" is declared to run after "${predecessor}", which the workflow ` +
            "graph does not contain. It could never succeed, so the stage could never run.",
        });
      }
    }
  }

  const cycle = findCycle(graph);
  if (cycle !== undefined) {
    problems.push({
      kind: "cycle",
      stages: cycle,
      message:
        `The workflow graph has a cycle: ${cycle.map((id) => `"${id}"`).join(" -> ")}. No stage ` +
        "in it could ever run, because each waits on another that waits on it.",
    });
  }

  return problems;
}

/**
 * The first cycle reachable in the graph, as the stages that form it.
 *
 * Returns the cycle rather than a boolean, because "your graph has a cycle" is not actionable and
 * `"a" -> "b" -> "a"` is.
 */
function findCycle(graph: WorkflowGraph): readonly string[] | undefined {
  const edges = new Map(graph.stages.map((node) => [node.stageId, node.after ?? []]));
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];

  function walk(stageId: string): readonly string[] | undefined {
    if (settled.has(stageId)) return undefined;
    if (onPath.has(stageId)) {
      // Trim to the cycle itself: the walk may have entered it from outside.
      return [...path.slice(path.indexOf(stageId)), stageId];
    }
    onPath.add(stageId);
    path.push(stageId);
    for (const predecessor of edges.get(stageId) ?? []) {
      const found = walk(predecessor);
      if (found !== undefined) return found;
    }
    path.pop();
    onPath.delete(stageId);
    settled.add(stageId);
    return undefined;
  }

  for (const node of graph.stages) {
    const found = walk(node.stageId);
    if (found !== undefined) return found;
  }
  return undefined;
}
