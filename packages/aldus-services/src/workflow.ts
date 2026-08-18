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
