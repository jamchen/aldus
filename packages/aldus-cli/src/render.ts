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

import type { ArtifactRecord } from "@aldus-runtime/artifact-registry";
import type { ArtifactRef } from "@aldus-runtime/core";
import type {
  ActionPlan,
  ArchiveReport,
  ArtifactLineageReport,
  ArtifactReport,
  CleanupPlanReport,
  CostReport,
  CostSummary,
  GateDecisionReport,
  InitReport,
  Inspection,
  PlanReport,
  ReleaseBundleReport,
  ReleaseExecutionReport,
  ReleaseReconciliationReport,
  ReleaseReport,
  ReworkStatusReport,
  RunReport,
  ScriptReport,
  StageRunReport,
  StartRunReport,
  StatusReport,
  SynthesisReport,
  TakeDecisionReport,
  TakeReport,
} from "@aldus-runtime/services";

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
  } else {
    // Stated rather than left out. The two outcomes previously differed only by an absent line,
    // so an operator who meant to create an Episode saw what looked like unqualified success.
    lines.push("No Episode created. Pass --show <id> to create one.");
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
      // Naming the gates here is what makes a list of Runs actionable: the whole point of the
      // derived status is that an operator can tell these apart at a glance (ADR-0026).
      const waiting =
        run.waitingOn !== undefined && run.waitingOn.length > 0
          ? `  waiting on ${run.waitingOn.join(", ")}`
          : "";
      const at = run.currentStage === undefined ? "" : `  at ${run.currentStage}`;
      lines.push(
        `  ${run.runId}  ${run.status}  ${run.workflowId}@${run.workflowVersion}${at}${waiting}`,
      );
    }
  }

  return lines.join("\n").trimEnd();
}

/** Render one Run's full picture. */
function renderRunReport(report: RunReport): string[] {
  const lines: string[] = [];
  // The derived state, not the manifest's stored one: the manifest records how the Run was
  // created and never changes (ADR-0026).
  const at = report.state.currentStage === undefined ? "" : `  at ${report.state.currentStage}`;
  lines.push(`Run      ${report.run.runId}  (${report.state.status})${at}`);
  lines.push(`Workflow ${report.run.workflowId}@${report.run.workflowVersion}`);
  if (report.state.waitingOn.length > 0) {
    // Named here so "waiting" does not send an operator hunting through the gate list.
    //
    // Only gates that still await a decision reach this line. A settled one used to appear for as
    // long as the parked attempt existed, so `status` told a reader to go and decide something
    // already decided — and the filtering is done in the derivation, not here, because the JSON
    // path serialises the same field this renders (#278, ADR-0059).
    lines.push(`Waiting  ${report.state.waitingOn.join(", ")}`);
  }
  for (const park of report.state.releasedStages) {
    // The other half of the same defect. A parked stage whose gate has been decided is not a gate
    // to decide, and it is not nothing either: nothing in the runtime re-runs a parked stage, so
    // the outstanding act is `run` and the operator has to be told which stage and which gate.
    lines.push(
      `Released ${park.stageId}  — gate "${park.gateId}" has been decided; run the stage again`,
    );
  }
  if (report.state.status === "cancelled" && report.run.cancellation !== undefined) {
    const reason =
      report.run.cancellation.reason === undefined ? "" : ` — ${report.run.cancellation.reason}`;
    lines.push(
      `Cancelled ${report.run.cancellation.cancelledAt} by ` +
        `${report.run.cancellation.cancelledBy.id}${reason}`,
    );
  }
  lines.push("");
  lines.push(...renderActionPlan(report.plan));

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
      // `enforcement` is the gate's **class**; `currentlyBlocking` is whether it is stopping work
      // **now**. These were rendered from the second alone, so a satisfied blocking gate printed
      // `(advisory)` — a false statement about its class, and a statement the gate's own definition
      // contradicts: `script.freeze` exists so that freezing a script without its QA is impossible
      // rather than discouraged, and `(advisory)` says precisely the discouraged reading.
      //
      // The gates it misdescribed were exactly the ones that had already done their job, because
      // being satisfied is what makes `currentlyBlocking` false. An adopter driving a real run found
      // every passing gate in their repository reported as advisory, and none of them is. The field
      // was renamed from `blocking` for the same reason (#204): the old name was the substitution.
      const stops = gate.currentlyBlocking ? "  — stops work" : "";
      lines.push(`  ${gate.gateId}  ${gate.state}  (${gate.enforcement})${stops}`);

      // **Why** it is stuck, which the engine already composed and this dropped.
      //
      // A gate binding a subject nothing produces reports `pending` — correctly, it is pending —
      // and `pending` reads as "nobody has got to it yet". The engine writes the distinguishing
      // sentence for exactly that case: "nothing has produced what the approval would bind". An
      // adopter hit an unproduced subject three times in one run and read all three as a step not
      // yet reached, because the sentence never left the report.
      //
      // Shown only where the operator needs it. A satisfied gate explaining itself is noise, and
      // noise is how the line that matters stops being read.
      if (gate.state !== "satisfied" && gate.state !== "waived") {
        if (gate.explanation !== undefined) lines.push(`      ${gate.explanation}`);
        if (gate.missingSubjects !== undefined && gate.missingSubjects.length > 0) {
          lines.push(`      not supplied: ${gate.missingSubjects.join(", ")}`);
        }
        if (gate.blockedBy !== undefined && gate.blockedBy.length > 0) {
          lines.push(`      blocked by: ${gate.blockedBy.join(", ")}`);
        }
      }
    }
  }

  const costLines = renderCostSummary(report.costs);
  if (costLines.length > 0) lines.push("", ...costLines);

  return lines;
}

/** Render the action plan: what is safe, then what is not and why. */
function renderActionPlan(plan: ActionPlan): string[] {
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
  // Reported separately, because these charges have no currency to name. Keying the warning off
  // `currenciesWithUnknownBilling` alone would print nothing for a provider that charged and
  // withheld the figure entirely — the reader would see clean totals and no note (#150).
  if (summary.unquantifiedUnknownBillingRecordCount > 0) {
    lines.push(
      `  note       ${summary.unquantifiedUnknownBillingRecordCount} charge(s) were billed with` +
        " no amount reported; the charged total may be understated and the remaining budget is" +
        " indeterminate.",
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

/**
 * Render `artifacts`.
 *
 * Registry-backed since #27, so archival state is shown per artifact rather than left to be
 * discovered. §8.1 requires irreplaceable artifacts to be archived **before** disposable files
 * are cleaned, and an operator who cannot see which ones lack an archive cannot honour that.
 */
export function renderArtifacts(report: ArtifactReport): string {
  if (report.artifacts.length === 0 && report.unregistered.length === 0) {
    return `No artifacts recorded for run ${report.runId}.`;
  }

  const lines = [`Artifacts for run ${report.runId}`];
  for (const record of report.records) {
    lines.push(`  ${describeArtifact(record.artifact)}  ${archiveState(record)}`);
  }

  if (report.unregistered.length > 0) {
    // Reported apart from the registered ones rather than merged: presenting an unregistered
    // entry alongside the rest would imply provenance and archival state nobody collected.
    lines.push(
      "",
      `Unregistered (${report.unregistered.length}) — present in the Run's collection, not in the registry`,
    );
    for (const artifact of report.unregistered) lines.push(`  ${describeArtifact(artifact)}`);
  }

  if (report.unarchivedIrreplaceable.length > 0) {
    lines.push(
      "",
      `${report.unarchivedIrreplaceable.length} irreplaceable artifact(s) are not archived. ` +
        "Contract §8.1 requires archival before any cleanup; run `aldus artifacts archive`.",
    );
  }

  return lines.join("\n");
}

/** One artifact, identified by ID and digest rather than by path (contract §8.1). */
function describeArtifact(artifact: ArtifactRef): string {
  return (
    `${artifact.artifactId}  ${artifact.kind}  ${artifact.reconstructability}  ` +
    `${artifact.sha256.slice(0, 12)}…`
  );
}

/** Whether an artifact's bytes are held, and whether the archive confirmed them. */
function archiveState(record: ArtifactRecord): string {
  if (record.archive === undefined) return "not archived";
  return record.archive.verified ? "archived" : "archived (unverified)";
}

/** Render `artifacts lineage` — where an artifact came from, and what came of it (contract §20). */
export function renderArtifactLineage(report: ArtifactLineageReport): string {
  const lines = [`Artifact ${report.artifactId}`, `  ${describeArtifact(report.record.artifact)}`];

  if (report.producer !== undefined) {
    const { runId, stageId, codeRevision, configHash } = report.producer;
    lines.push("", "Produced by", `  run ${runId}, stage ${stageId}`);
    // §20 must answer which code and configuration were used; absent is said, not omitted.
    lines.push(`  code revision  ${codeRevision ?? "(not recorded)"}`);
    lines.push(
      `  configuration  ${configHash === undefined ? "(not recorded)" : configHash.slice(0, 12) + "…"}`,
    );
  }

  lines.push("", `Inputs (${report.inputs.length})`);
  for (const edge of report.inputs) {
    const resolved =
      edge.records.length > 0
        ? edge.records.map((record) => record.artifact.artifactId).join(", ")
        : "(no registered artifact holds this digest)";
    lines.push(`  ${edge.sha256.slice(0, 12)}…  ${resolved}`);
  }

  lines.push("", `Derived from it (${report.consumers.length})`);
  for (const consumer of report.consumers) lines.push(`  ${describeArtifact(consumer.artifact)}`);

  lines.push(
    "",
    `Ancestors ${report.ancestors.records.length}  Descendants ${report.descendants.records.length}`,
  );
  for (const result of [report.ancestors, report.descendants]) {
    if (result.unresolvedDigests.length > 0) {
      lines.push(
        `  note: ${result.unresolvedDigests.length} input digest(s) match no registered artifact`,
      );
    }
    // A cycle cannot happen in correct data, so saying so plainly beats a silently truncated graph.
    if (result.cycles.length > 0) {
      lines.push(`  warning: lineage cycle through ${result.cycles.join(", ")}`);
    }
  }

  return lines.join("\n");
}

/** Render `artifacts cleanup-plan` — what a cleanup would remove, before anything is removed. */
export function renderCleanupPlan(report: CleanupPlanReport): string {
  const lines = [
    `Cleanup plan for run ${report.runId}`,
    report.safe
      ? `  safe: ${report.removable.length} artifact(s) may have their working files removed`
      : `  NOT safe: ${report.blocked.length} artifact(s) block this plan`,
  ];

  if (report.blocked.length > 0) {
    lines.push("", "Blocked");
    for (const block of report.blocked) {
      lines.push(`  ${block.record.artifact.artifactId}  ${block.reason}`);
      lines.push(`      ${block.explanation}`);
    }
  }

  if (report.removable.length > 0) {
    lines.push("", "Removable");
    for (const record of report.removable) lines.push(`  ${describeArtifact(record.artifact)}`);
  }

  if (report.unknownArtifactIds.length > 0) {
    lines.push("", `Not registered: ${report.unknownArtifactIds.join(", ")}`);
  }

  return lines.join("\n");
}

/** Render `artifacts archive` (contract §8.1). */
export function renderArchive(report: ArchiveReport): string {
  if (report.archived.length === 0 && report.alreadyArchived.length === 0) {
    return `Run ${report.runId} has no irreplaceable artifacts, so there is nothing to archive.`;
  }
  const lines = [
    `Archived ${report.archived.length} artifact(s) for run ${report.runId}` +
      (report.alreadyArchived.length > 0
        ? `; ${report.alreadyArchived.length} already held a verified receipt`
        : ""),
  ];
  for (const record of report.archived) lines.push(`  ${describeArtifact(record.artifact)}`);
  return lines.join("\n");
}

/**
 * Render `costs`.
 *
 * `actorKind` shapes the remedy lines, because reconciliation is a human decision (§13.3, §19.3)
 * and this listing is where an agent coordinator looks. Printing the plain form to an agent tells
 * the current actor to run a command the current actor may not run — reported by the first adopter
 * from the first real use, at the cost of a round trip, and it would have cost every adopter the
 * same one.
 *
 * The guidance therefore **is** the rule rather than a sentence about it: an agent is told to
 * transcribe a human's decision, which is the only shape that will work for them.
 */
export function renderCosts(report: CostReport, actorKind?: string): string {
  const summary = renderCostSummary(report.summary);

  // **Unresolved charges first, and shown even when nothing settled.** An unresolved charge blocks
  // every later dispatch on its grant, and this command printed the settled records and a total as
  // if nothing were pending — so the state that stopped a Run was invisible in the one command
  // whose whole job is the money (#215). It also names the remedy: the reservation id below is
  // what `aldus costs settle` takes.
  // Two kinds, and conflating them would be the defect one layer along. An unresolved charge
  // **blocks** every later dispatch and needs a decision. A reservation whose dispatch began and
  // has not settled **holds** authorization and may simply be in flight — the runtime cannot tell
  // a live one from a process that died mid-round, so it is reported rather than flagged.
  // Reconciliation is a human decision, so an agent reading this needs the transcription form or
  // it will run a command that refuses it. Absent actor kind gets the plain form: an unknown actor
  // is not evidence of an agent, and adding the clause everywhere would make it noise a human
  // learns to skip — which is how a hint stops working on the day it matters.
  const transcribe =
    actorKind === "human" || actorKind === undefined
      ? ""
      : "\n  reconciliation is a human decision, so record theirs: --decided-by <actor> --verbatim <text>";
  const unresolved = report.unresolved.filter((entry) => entry.status === "billing_unknown");
  const held = report.unresolved.filter((entry) => entry.status === "reserved");
  const line = (entry: (typeof report.unresolved)[number]): string =>
    `  ${entry.reservationId}  ${entry.status}  holds ${entry.reservedAuthorizationAmount.amount} ` +
    `${entry.reservedAuthorizationAmount.currency}  (${entry.operation})`;

  const blocked = [
    ...(unresolved.length === 0
      ? []
      : [
          `${unresolved.length} unresolved charge(s) — every later dispatch on the grant is refused`,
          ...unresolved.map(line),
          `  resolve with: aldus costs settle <reservation-id> --evidence <what it rests on>${transcribe}`,
          "",
        ]),
    ...(held.length === 0
      ? []
      : [
          `${held.length} reservation(s) holding authorization, not yet settled`,
          ...held.map(line),
          "  in flight, or left behind by a process that ended mid-dispatch — this cannot tell",
          // Named `abandon`, not `settle`. The previous line pointed at `settle`, which accepts
          // only `billing_unknown` and refuses every reservation listed here — so the one place
          // that tells an operator what to do named the one command that would refuse them
          // (#226). A verb offered for a state that cannot accept it is worse than no verb: it
          // spends the operator's trust before it spends their time.
          "  which. `aldus costs abandon <reservation-id> --reason <why>` records that one is not",
          `  coming back; it is then reconcilable with \`aldus costs settle\`.${transcribe}`,
          "",
        ]),
  ];

  if (summary.length === 0 && blocked.length === 0) {
    return `No costs recorded for run ${report.runId}.`;
  }
  return [`Run ${report.runId}`, "", ...blocked, ...summary].join("\n");
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

/**
 * Render `release plan` — a bundle's derived state (contract §17, §19.1).
 *
 * Derived on every call rather than stored, so what is shown is what is true now. `remaining` is
 * the operative line: §19.1 requires recovery from partial success, and an operator resuming a
 * half-executed bundle needs to know what is left rather than what was attempted.
 */
export function renderReleaseBundle(report: ReleaseBundleReport): string {
  const lines = [
    `Bundle ${report.bundleId} for run ${report.runId}: ${report.status.state}`,
    "",
    "Operations",
  ];
  for (const operation of report.status.operations) {
    lines.push(
      `  ${operation.operationId}  ${operation.kind} → ${operation.destination}  ` +
        `${operation.state}  (${operation.criticality})`,
    );
  }
  if (report.status.remaining.length > 0) {
    lines.push("", `Remaining: ${report.status.remaining.join(", ")}`);
  }
  return lines.join("\n");
}

/** Render `release reconcile` (contract §17). */
export function renderReleaseReconciliation(report: ReleaseReconciliationReport): string {
  const { findings, repaired } = report.report;
  const lines = [`Reconciled bundle ${report.bundleId} for run ${report.runId}`];

  if (findings.length === 0) {
    lines.push("  nothing to reconcile");
  } else {
    for (const finding of findings) {
      lines.push(`  ${finding.operationId}  ${finding.action}`);
      if (finding.explanation !== undefined) lines.push(`      ${finding.explanation}`);
    }
  }

  if (repaired.length > 0) {
    lines.push(
      "",
      `${repaired.length} receipt(s) repaired — those operations already happened at their ` +
        "destination and will not be performed again.",
    );
  }
  return lines.join("\n");
}

/**
 * Render `release execute` (contract §17, §13.4).
 *
 * Warnings are printed rather than summarised away: a best-effort failure does not fail the
 * release (§17), which is exactly why it would otherwise go unnoticed.
 */
export function renderReleaseExecution(report: ReleaseExecutionReport): string {
  const { outcome } = report;
  const lines = [`Bundle ${report.bundleId} for run ${report.runId}: ${outcome.state}`];

  if (outcome.written.length > 0) {
    lines.push("", "Receipts written");
    for (const receipt of outcome.written) {
      const remote = receipt.remoteId === undefined ? "" : `  ${receipt.remoteId}`;
      lines.push(`  ${receipt.operation} → ${receipt.destination}: ${receipt.status}${remote}`);
    }
  }

  if (outcome.warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of outcome.warnings) lines.push(`  - ${warning}`);
  }

  if (outcome.status.remaining.length > 0) {
    lines.push("", `Remaining: ${outcome.status.remaining.join(", ")}`);
  }
  return lines.join("\n");
}

/** Render `script record` (contract §14.1). */
export function renderScript(report: ScriptReport): string {
  return [
    `Recorded PerformanceScript ${report.script.scriptId} for run ${report.runId}`,
    `Origin:   ${report.script.origin}`,
    `Segments: ${report.script.segments.length}`,
  ].join("\n");
}

/**
 * Render `synthesis plan` (contract §13.2, §15).
 *
 * Says plainly that recording a plan is not authorization. A plan is the thing an operator
 * approves; conflating the two is how someone comes to believe spend was permitted because a
 * plan exists.
 */
export function renderPlan(report: PlanReport): string {
  const lines = [
    `Recorded request plan ${report.plan.planId} for run ${report.runId}`,
    `Segments: ${report.plan.segments.length}`,
  ];
  if (report.plan.estimatedTotal !== undefined) {
    lines.push(
      `Estimated: ${report.plan.estimatedTotal.amount} ${report.plan.estimatedTotal.currency}`,
    );
  }
  lines.push(
    "",
    "Recording a plan authorizes nothing. Synthesis additionally requires an approved gate " +
      "binding this plan and a spend grant (contract §13.2).",
  );
  return lines.join("\n");
}

/** Render one synthesis, or a recorded unauthorized charge (contract §15). */
export function renderSynthesis(report: SynthesisReport): string {
  const lines = [
    `Segment ${report.segmentId} of plan ${report.planId} — take ${report.take.takeId}`,
    `Attempt:  ${report.take.attempt}`,
    `Adapter:  ${report.adapterId}`,
  ];
  if (report.take.audioSha256 !== undefined) {
    lines.push(`Audio:    ${report.take.audioSha256.slice(0, 12)}…`);
  }
  if (report.take.authorization !== undefined) {
    lines.push(
      `Authorized by gate ${report.take.authorization.gateId}, decision ` +
        `${report.take.authorization.decisionId}`,
    );
  }
  if (report.take.unauthorizedCharge !== undefined) {
    // The marker is the point of the record. Hiding it would launder the charge into an ordinary
    // take, which is precisely what recording it separately exists to prevent.
    lines.push(
      "",
      "UNAUTHORIZED CHARGE — recorded so production trace can answer what this cost " +
        "(contract §20). It was not authorized under §13.2.",
      `Reason: ${report.take.unauthorizedCharge.reason}`,
    );
  }
  lines.push("", "Not yet judged. A human decides whether to accept it (contract §13.3).");
  return lines.join("\n");
}

/** Render `takes decide` (contract §13.3). */
export function renderTakeDecision(report: TakeDecisionReport): string {
  const decision = report.take.decision;
  const lines = [`Take ${report.take.takeId}: ${decision?.decision ?? "undecided"}`];
  if (decision?.reason !== undefined) lines.push(`Reason: ${decision.reason}`);
  return lines.join("\n");
}

/**
 * Render `takes` (contract §15, §15.1).
 *
 * Rejected takes are counted rather than filtered away. §15.1 requires them retained, because a
 * rejected take is evidence of what was tried and the input to the next repair decision.
 */
export function renderTakes(report: TakeReport): string {
  if (report.takes.length === 0) return `No takes recorded for run ${report.runId}.`;

  const lines = [`Takes for run ${report.runId}`];
  for (const segment of report.lineage) {
    const accepted = segment.accepted === undefined ? "none accepted" : segment.accepted.takeId;
    lines.push(
      `  ${segment.segmentId}  ${segment.takes.length} take(s)  accepted: ${accepted}` +
        (segment.rejected.length > 0 ? `  rejected: ${segment.rejected.length}` : ""),
    );
    if (segment.repairPath.length > 0) {
      lines.push(`      repairs: ${segment.repairPath.join(" → ")}`);
    }
  }

  if (report.awaitingAcceptance.length > 0) {
    lines.push(
      "",
      `Awaiting a human ear (contract §13.3): ${report.awaitingAcceptance.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the result of abandoning a Run (contract §19.1).
 *
 * States who and when, because that is the whole content of the decision — §20 asks trace who
 * performed something, and "cancelled" without an actor answers half the question.
 */
export function renderCancelRun(report: RunReport): string {
  const cancellation = report.run.cancellation;
  const lines = [`Run ${report.run.runId} cancelled.`];
  if (cancellation !== undefined) {
    lines.push(`  by       ${cancellation.cancelledBy.id} (${cancellation.cancelledBy.kind})`);
    lines.push(`  at       ${cancellation.cancelledAt}`);
    if (cancellation.reason !== undefined) lines.push(`  reason   ${cancellation.reason}`);
  }
  // The command, not the intention. This said "Start a new Run to continue this Episode." and the
  // obvious next command then failed on a missing `--workflow` — an instruction that names a step
  // without naming what it needs is one an operator discovers is wrong by following it.
  lines.push("", "Start a new Run to continue this Episode:");
  lines.push("  aldus start --workflow <workflow-id> --workflow-version <version>");
  return lines.join("\n");
}

/**
 * Render `rework status` (#220, closed 2026-09-03: the executor is the adopter's, not Aldus's).
 *
 * **Every line says which kind of statement it is.** Nothing executes a declared policy yet, so
 * completed repairs are labelled `recorded` and the decision is labelled `would decide` — a
 * preview, not something the runtime did. An operator reading an unlabelled "stopped" would take it
 * as runtime-controlled execution that has not happened.
 *
 * The stop reason prints its sentence, not only its enumerated name: "bounds_exhausted" says what
 * state it is in, and the two most useful reasons argue against the obvious next move.
 */
export function renderRework(report: ReworkStatusReport): string {
  if (report.loops.length === 0) {
    return `No rework policy is declared for run ${report.runId}.`;
  }

  const lines: string[] = [
    `Run ${report.runId}`,
    "",
    "Aldus does not execute a rework policy, by decision rather than for want of one (#220).",
    "Repairs below are recorded executions the policy's joins match; the decision is what the",
    "policy would answer, and taking it belongs to whoever owns the money and the judgement.",
    "",
  ];

  for (const loop of report.loops) {
    lines.push(`${loop.policyId}  (${loop.stageId})`);
    lines.push(`  recorded rounds  ${loop.recordedRounds.length}`);
    for (const round of loop.recordedRounds) {
      const counted =
        round.inputFindingCount === undefined
          ? "  (not measured)"
          : `  ${round.inputFindingCount} finding(s)`;
      lines.push(
        `    ${round.roundIndex}. ${round.inputDigest.slice(0, 8)} → ` +
          `${round.outputDigest.slice(0, 8)}${counted}  ${round.repairAttemptId}`,
      );
    }

    // Surfaced, never dropped. A repair missing from the list above reads as one that never ran,
    // and a reader comparing that against a bound concludes there is room left.
    if (loop.refusedRepairs.length > 0) {
      lines.push(
        `  not joined       ${loop.refusedRepairs.length} repair(s) the record cannot place`,
      );
      for (const refused of loop.refusedRepairs) {
        lines.push(`    ${refused.repairAttemptId}  ${refused.reason}: ${refused.explanation}`);
      }
    }

    if (loop.wouldDecide === undefined) {
      // Not "converged", and not a decision. A loop that has not started and one that finished
      // clean leave the same empty round list, and only one of them is a pass.
      lines.push(`  no preview       ${loop.previewUnavailable ?? "nothing to decide about"}`);
      lines.push("");
      continue;
    }

    switch (loop.wouldDecide.kind) {
      case "converged":
        lines.push("  would decide     converged — nothing blocking and nothing the policy covers");
        break;
      case "rework":
        lines.push(
          `  would decide     round ${loop.wouldDecide.round}: run ${loop.wouldDecide.repairStageId} ` +
            `on ${loop.wouldDecide.consumeFindingClasses.join(", ")}`,
        );
        break;
      case "escalate":
        lines.push(
          `  would decide     stop (${loop.wouldDecide.reason}) — decide ${loop.wouldDecide.gateId}`,
        );
        lines.push(`                   ${loop.wouldDecide.explanation}`);
        // Every candidate, because the loop carries the newest forward and the newest is not the
        // best after a regression. Reported, never ranked (ADR-0056).
        if (loop.wouldDecide.candidates.length > 1) {
          lines.push("  candidates       (not ranked — fewer findings is not better, it is fewer)");
          for (const candidate of loop.wouldDecide.candidates) {
            const counted =
              candidate.findingCount === undefined
                ? "  (not measured)"
                : `  ${candidate.findingCount} finding(s)`;
            lines.push(`                   ${candidate.digest.slice(0, 8)}${counted}`);
          }
        }
        break;
      // Not an escalation, and it must not read like one: there is no gate to decide and no
      // candidate to choose (ADR-0057). The lines name the attempt, say what is unestablished, and
      // print the remedy sentence unaltered — an operator acting on a summary of it is the failure
      // the wording was written against.
      case "reconciliation_required":
        lines.push(
          `  would decide     reconcile — attempt ${loop.wouldDecide.attemptId} of ` +
            `${loop.wouldDecide.stageId} is recorded running`,
        );
        lines.push(`                   ${loop.wouldDecide.explanation}`);
        // Reported, never read as an outcome, and labelled so. An empty list is the ordinary case
        // for a stuck attempt and is not evidence that nothing happened.
        lines.push(
          `  recorded so far  ${loop.wouldDecide.recordedCostIds?.length ?? 0} cost record(s), ` +
            `${loop.wouldDecide.recordedArtifactDigests?.length ?? 0} artifact(s) — neither ` +
            "establishes whether the evaluation finished",
        );
        break;
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
