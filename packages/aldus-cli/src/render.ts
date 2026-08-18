/**
 * Human-readable rendering (architecture contract §18).
 *
 * §18 requires both "machine-readable JSON output" and "human-readable summaries". The
 * constraint that makes that honest is that **both come from one service call** — the renderer
 * formats the same structured result the JSON path serialises, and never queries anything itself.
 * A renderer that re-read state could show something the JSON did not, and then the two outputs
 * would disagree about the same moment.
 *
 * No colour, no cursor control, no width detection. Output is piped as often as it is read, and
 * escape codes in a log file are noise an operator has to strip before they can grep it.
 */

import type {
  ActionPlan,
  CostReport,
  CostSummary,
  GateDecisionReport,
  Inspection,
  ReleaseReport,
  RunReport,
  StageRunReport,
  StatusReport,
} from "@aldus-runtime/services";
import type { ArtifactReport, InitReport, StartRunReport } from "@aldus-runtime/services";

/** Render `init`. */
export function renderInit(report: InitReport): string {
  const lines = [
    report.created
      ? `Initialised workspace at ${report.workspaceRoot}`
      : `Workspace already initialised at ${report.workspaceRoot}`,
  ];
  if (report.episode !== undefined) {
    lines.push(`Episode: ${report.episode.episodeId}`);
    if (report.episode.title !== undefined) lines.push(`Title:   ${report.episode.title}`);
  }
  return lines.join("\n");
}

/** Render `start`. */
export function renderStartRun(report: StartRunReport): string {
  return [
    `Started run ${report.run.runId}`,
    `Workflow: ${report.run.workflowId}@${report.run.workflowVersion}`,
    `Episode:  ${report.run.episode.episodeId}`,
  ].join("\n");
}

/**
 * Render `status`.
 *
 * The next-action block comes first, before any table. §24 asks that an operator see the next
 * safe action without reading chat history; burying it under a state dump would satisfy the
 * letter of that and miss the point.
 */
export function renderStatus(report: StatusReport): string {
  const lines: string[] = [report.summary, ""];

  if (report.episode !== undefined) {
    lines.push(`Episode  ${report.episode.episodeId}`);
    if (report.episode.title !== undefined) lines.push(`Title    ${report.episode.title}`);
    lines.push("");
  }

  if (report.focused !== undefined) {
    lines.push(...renderRunReport(report.focused));
  } else if (report.runs.length > 0) {
    lines.push("Runs");
    for (const run of report.runs) {
      lines.push(`  ${run.runId}  ${run.status}  ${run.workflowId}@${run.workflowVersion}`);
    }
  }

  return lines.join("\n").trimEnd();
}

/** Render one Run's full picture. */
function renderRunReport(report: RunReport): string[] {
  const lines: string[] = [];
  lines.push(`Run      ${report.run.runId}  (${report.run.status})`);
  lines.push(`Workflow ${report.run.workflowId}@${report.run.workflowVersion}`);
  lines.push("");
  lines.push(...renderPlan(report.plan));

  if (report.stages.length > 0) {
    lines.push("", "Stages");
    for (const stage of report.stages) {
      const attempt = stage.attempt === undefined ? "" : `  attempt ${stage.attempt}`;
      const unregistered = stage.registered ? "" : "  (definition no longer registered)";
      lines.push(`  ${stage.stageId}  ${stage.status}${attempt}${unregistered}`);
    }
  }

  if (report.gates.length > 0) {
    lines.push("", "Gates");
    for (const gate of report.gates) {
      const blocking = gate.blocking ? "blocking" : "advisory";
      lines.push(`  ${gate.gateId}  ${gate.state}  (${blocking})`);
    }
  }

  const costLines = renderCostSummary(report.costs);
  if (costLines.length > 0) lines.push("", ...costLines);

  return lines;
}

/** Render the action plan: what is safe, then what is not and why. */
function renderPlan(plan: ActionPlan): string[] {
  const lines: string[] = [];

  if (plan.next.length === 0) {
    lines.push("Next: nothing is currently safe to do.");
  } else {
    lines.push("Next");
    for (const action of plan.next) {
      lines.push(`  - ${action.summary}`);
      if (action.command !== undefined) lines.push(`      ${action.command}`);
    }
  }

  if (plan.blocked.length > 0) {
    lines.push("", "Blocked");
    for (const blocked of plan.blocked) {
      lines.push(`  - ${blocked.summary}`);
      lines.push(`      ${blocked.reason}`);
    }
  }

  return lines;
}

/** Render cost totals, or nothing when there are none. */
function renderCostSummary(summary: CostSummary): string[] {
  if (summary.recordCount === 0) return [];
  const lines = [`Costs (${summary.recordCount} record${summary.recordCount === 1 ? "" : "s"})`];

  for (const [currency, amount] of Object.entries(summary.actualByCurrency)) {
    lines.push(`  charged    ${amount} ${currency}`);
  }
  for (const [currency, amount] of Object.entries(summary.estimatedByCurrency)) {
    lines.push(`  estimated  ${amount} ${currency}`);
  }
  if (summary.currenciesWithUnknownBilling.length > 0) {
    lines.push(
      `  note       billing is unconfirmed for ${summary.currenciesWithUnknownBilling.join(", ")};` +
        " the charged total may be understated.",
    );
  }
  return lines;
}

/** Render `inspect`. */
export function renderInspection(inspection: Inspection): string {
  if (inspection.kind === "episode") {
    const lines = [`Episode  ${inspection.episode.episodeId}`];
    if (inspection.episode.title !== undefined) lines.push(`Title    ${inspection.episode.title}`);
    lines.push(`Show     ${inspection.episode.showId}`, "", `Runs (${inspection.runs.length})`);
    for (const run of inspection.runs) lines.push(`  ${run.runId}  ${run.status}`);
    return lines.join("\n");
  }

  const lines = renderRunReport(inspection.report);
  lines.push(
    "",
    `Artifacts ${inspection.artifacts.length}`,
    `Approvals ${inspection.approvals}`,
    `Releases  ${inspection.releases.length}`,
  );
  return lines.join("\n");
}

/** Render a stage run or retry. */
export function renderStageRun(report: StageRunReport): string {
  const lines = [`Stage ${report.stageId} — ${report.status} (attempt ${report.attempt})`];
  if (report.gateId !== undefined) lines.push(`Waiting for gate: ${report.gateId}`);
  if (report.error !== undefined) {
    lines.push(`Error: ${report.error.code} — ${report.error.message}`);
    lines.push(`Retryable: ${report.error.retryable ? "yes" : "no"}`);
  }
  if (report.outputArtifacts.length > 0) {
    lines.push(`Artifacts recorded: ${report.outputArtifacts.length}`);
  }
  return lines.join("\n");
}

/** Render a recorded gate decision, including the cascade it caused. */
export function renderGateDecision(report: GateDecisionReport): string {
  const lines = [
    `Recorded ${report.decision} on gate ${report.gateId} (decision ${report.decisionId})`,
  ];
  if (report.gates.length > 0) {
    lines.push("", "Gates now");
    for (const gate of report.gates) lines.push(`  ${gate.gateId}  ${gate.state}`);
  }
  return lines.join("\n");
}

/** Render `artifacts`. */
export function renderArtifacts(report: ArtifactReport): string {
  if (report.artifacts.length === 0) return `No artifacts recorded for run ${report.runId}.`;
  const lines = [`Artifacts for run ${report.runId}`];
  for (const artifact of report.artifacts) {
    lines.push(
      `  ${artifact.artifactId}  ${artifact.kind}  ${artifact.reconstructability}  ` +
        `${artifact.sha256.slice(0, 12)}…`,
    );
  }
  return lines.join("\n");
}

/** Render `costs`. */
export function renderCosts(report: CostReport): string {
  const summary = renderCostSummary(report.summary);
  if (summary.length === 0) return `No costs recorded for run ${report.runId}.`;
  return [`Run ${report.runId}`, "", ...summary].join("\n");
}

/** Render `release status`. */
export function renderRelease(report: ReleaseReport): string {
  if (report.receipts.length === 0)
    return `No release operations recorded for run ${report.runId}.`;
  const lines = [`Release operations for run ${report.runId}`];
  for (const receipt of report.receipts) {
    lines.push(`  ${receipt.operation} → ${receipt.destination}: ${receipt.status}`);
  }
  if (report.pending.length > 0) {
    lines.push(
      "",
      `${report.pending.length} operation(s) are pending — their remote outcome is unknown and ` +
        "must be reconciled before retrying, or the operation may be performed twice.",
    );
  }
  return lines.join("\n");
}
