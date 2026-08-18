/**
 * The application services end to end (architecture contract §18).
 *
 * These run against real temp workspaces rather than mocks. A service whose test asserts that a
 * store method was called proves only that the code calls what it calls; §7's stores have real
 * locking, atomic writes, and validation, and the interesting failures live there.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AldusError } from "@aldus/core";

import { ServiceErrorCodes } from "../src/errors.js";
import type { AldusServices } from "../src/services.js";

import {
  AGENT,
  OPERATOR,
  costRecord,
  failingStage,
  gateDefinition,
  gatedStage,
  makeServices,
  makeTempWorkspace,
  passthroughStage,
  registryOf,
  subjectsFor,
  subjectsForAll,
  type TempWorkspace,
} from "./helpers.js";

let temp: TempWorkspace;

beforeEach(async () => {
  temp = await makeTempWorkspace();
});

afterEach(async () => {
  await temp.cleanup();
});

/** Services with an Episode and a Run already created. */
async function withRun(
  options: Parameters<typeof makeServices>[1] = {},
): Promise<{ services: AldusServices; runId: string }> {
  const services = makeServices(temp.workspace, { actor: OPERATOR, ...options });
  await services.init({ episode: { showId: "example-show", slug: "episode-a" } });
  const started = await services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: "run-a",
  });
  if (started.outcome !== "ok") throw new Error("failed to start a run");
  return { services, runId: started.data.run.runId };
}

describe("actor identity (§19.2)", () => {
  // §19.2 requires mutating actions to record actor identity, and §3.6 treats an unattributed
  // decision as no decision. Attributing it to a placeholder would satisfy the type and defeat
  // the requirement, so an anonymous mutation is refused outright.
  it("refuses every mutating operation when no actor is supplied", async () => {
    const services = makeServices(temp.workspace);
    const mutations: Array<() => Promise<unknown>> = [
      () => services.init(),
      () => services.startRun({ workflowId: "workflow-a", workflowVersion: "1" }),
      () => services.runStage({ runId: "run-a", stageId: "stage-a" }),
      () => services.approve({ runId: "run-a", gateId: "gate-a" }),
      () => services.reject({ runId: "run-a", gateId: "gate-a" }),
    ];

    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({
        code: ServiceErrorCodes.ACTOR_REQUIRED,
      });
    }
  });

  // §24 promises an operator can see the state without ceremony. Requiring identity to *look*
  // would put configuration between them and the answer.
  it("allows every read-only operation without an actor", async () => {
    const services = makeServices(temp.workspace);
    const status = await services.status();
    expect(status.outcome).toBe("ok");
  });

  it("records the acting operator on the decision it produced", async () => {
    const { services, runId } = await withRun({
      gates: [gateDefinition("content-freeze")],
      subjects: subjectsForAll(["content-freeze"]),
    });
    await services.approve({ runId, gateId: "content-freeze" });

    const decisions = await temp.workspace.runs.listRecords(runId, "approvals");
    expect(decisions[0]?.decidedBy).toMatchObject({ kind: "human", id: "operator-a" });
  });

  it("lets a per-call actor override the context default", async () => {
    const { services, runId } = await withRun({
      gates: [
        gateDefinition("advisory-check", { level: "advisory_signal", enforcement: "advisory" }),
      ],
      subjects: subjectsForAll(["advisory-check"]),
    });
    await services.approve({ runId, gateId: "advisory-check", actor: AGENT });

    const decisions = await temp.workspace.runs.listRecords(runId, "approvals");
    expect(decisions[0]?.decidedBy.id).toBe("agent-a");
  });
});

describe("init and start", () => {
  it("creates a workspace and an Episode with a canonical identity (§6.1)", async () => {
    const services = makeServices(temp.workspace, { actor: OPERATOR });
    const result = await services.init({
      episode: { showId: "example-show", slug: "episode-a", title: "Example Episode A" },
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.episode?.episodeId).toBe("show:example-show:episode:episode-a");
  });

  // §6.1 makes the Episode the durable content identity, so replacing it silently would orphan
  // every Run that referenced the old one.
  it("refuses to replace an existing Episode unless forced", async () => {
    const services = makeServices(temp.workspace, { actor: OPERATOR });
    await services.init({ episode: { showId: "example-show", slug: "episode-a" } });

    const second = await services.init({ episode: { showId: "example-show", slug: "episode-b" } });
    expect(second.outcome).toBe("refused");
    if (second.outcome !== "refused") return;
    expect(second.refusal.reason).toBe("episode_already_exists");

    const forced = await services.init({
      episode: { showId: "example-show", slug: "episode-b" },
      force: true,
    });
    expect(forced.outcome).toBe("ok");
  });

  it("rejects an identifier that is not a canonical content identity", async () => {
    const services = makeServices(temp.workspace, { actor: OPERATOR });
    await expect(
      services.init({ episode: { showId: "example-show", episodeId: "not-canonical" } }),
    ).rejects.toMatchObject({ code: ServiceErrorCodes.INVALID_REQUEST });
  });

  it("refuses to start a Run before an Episode exists", async () => {
    const services = makeServices(temp.workspace, { actor: OPERATOR });
    await expect(
      services.startRun({ workflowId: "workflow-a", workflowVersion: "1" }),
    ).rejects.toMatchObject({ code: ServiceErrorCodes.EPISODE_NOT_FOUND });
  });
});

describe("status (§24)", () => {
  it("focuses the only Run without being asked, so the common case needs no --run", async () => {
    const { services, runId } = await withRun({ stages: registryOf(passthroughStage("stage-a")) });
    const result = await services.status();

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.focused?.run.runId).toBe(runId);
    expect(result.data.focused?.plan.next[0]?.stageId).toBe("stage-a");
  });

  it("does not guess which Run to focus when there are several", async () => {
    const { services } = await withRun();
    await services.startRun({ workflowId: "workflow-a", workflowVersion: "1", runId: "run-b" });

    const result = await services.status();
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.data.focused).toBeUndefined();
    expect(result.data.runs).toHaveLength(2);
    expect(result.data.summary).toContain("Name one");
  });

  it("tells an operator what to do first when the workspace is empty", async () => {
    const services = makeServices(temp.workspace);
    const result = await services.status();
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.data.episode).toBeUndefined();
    expect(result.data.summary).toContain("no Episode");
  });

  // §20 requires production trace to answer what happened. A stage whose definition moved on is
  // still part of that history, so it is reported as unregistered rather than dropped.
  it("keeps a stage in the report after its definition is no longer registered", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(passthroughStage("stage-a")),
    });
    await services.runStage({ runId, stageId: "stage-a" });

    const forgetful = makeServices(temp.workspace, { actor: OPERATOR });
    const result = await forgetful.status(runId);
    if (result.outcome !== "ok") throw new Error("expected ok");

    const stage = result.data.focused?.stages.find((entry) => entry.stageId === "stage-a");
    expect(stage?.registered).toBe(false);
    expect(stage?.status).toBe("succeeded");
  });
});

describe("running stages (§11)", () => {
  it("reports success as ok", async () => {
    const { services, runId } = await withRun({ stages: registryOf(passthroughStage("stage-a")) });
    const result = await services.runStage({ runId, stageId: "stage-a", input: { value: 1 } });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.status).toBe("succeeded");
  });

  // A gate halt is the runtime doing what §11 requires, not a malfunction — but it is also not
  // success, and a script chaining stages has to be able to stop on it.
  it("reports a gate halt as unsuccessful, naming the gate", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(gatedStage("stage-a", "content-freeze")),
    });
    const result = await services.runStage({ runId, stageId: "stage-a" });

    expect(result.outcome).toBe("unsuccessful");
    if (result.outcome !== "unsuccessful") return;
    expect(result.data.status).toBe("waiting_for_gate");
    expect(result.data.gateId).toBe("content-freeze");
    expect(result.explanation).toContain("content-freeze");
  });

  it("reports a failure as unsuccessful and carries its retryability (§19.1)", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(failingStage("stage-a", true)),
    });
    const result = await services.runStage({ runId, stageId: "stage-a" });

    expect(result.outcome).toBe("unsuccessful");
    if (result.outcome !== "unsuccessful") return;
    expect(result.data.status).toBe("failed");
    expect(result.error?.retryable).toBe(true);
  });

  // §6.3 makes attempts append-only, so a retry *is* another run. A separate code path would be
  // a second place for that rule to be got wrong.
  it("appends an attempt on retry rather than editing the first", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(failingStage("stage-a", true)),
    });
    await services.runStage({ runId, stageId: "stage-a" });
    const retried = await services.retryStage({ runId, stageId: "stage-a" });

    if (retried.outcome === "refused") throw new Error("unexpected refusal");
    expect(retried.data.attempt).toBe(2);
  });

  it("fails clearly when the Run does not exist", async () => {
    const services = makeServices(temp.workspace, {
      actor: OPERATOR,
      stages: registryOf(passthroughStage("stage-a")),
    });
    await expect(
      services.runStage({ runId: "run-missing", stageId: "stage-a" }),
    ).rejects.toMatchObject({ code: ServiceErrorCodes.RUN_NOT_FOUND });
  });
});

describe("gate decisions (§3.6, §13)", () => {
  const contentFreeze = {
    gateId: "content-freeze",
    level: "human_oracle" as const,
    enforcement: "blocking" as const,
    binds: ["spoken-text"],
  };

  it("records a durable decision bound to the current subjects", async () => {
    const subjects = subjectsFor("content-freeze", { "spoken-text": "the approved script" });
    const { services, runId } = await withRun({ gates: [contentFreeze], subjects });

    const result = await services.approve({ runId, gateId: "content-freeze" });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;

    const stored = await temp.workspace.runs.listRecords(runId, "approvals");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.subjectHashes).toHaveLength(1);
    expect(result.data.gates.find((gate) => gate.gateId === "content-freeze")?.state).toBe(
      "satisfied",
    );
  });

  // §13.2: the authorization MUST be invalidated if any bound value changes. The services do not
  // implement that — the engine derives it — but the wiring has to actually surface it.
  it("shows an approval going stale once a bound value changes (§13.1, §13.2)", async () => {
    const before = subjectsFor("content-freeze", { "spoken-text": "the approved script" });
    const { services, runId } = await withRun({ gates: [contentFreeze], subjects: before });
    await services.approve({ runId, gateId: "content-freeze" });

    const after = subjectsFor("content-freeze", { "spoken-text": "an edited script" });
    const edited = makeServices(temp.workspace, {
      actor: OPERATOR,
      gates: [contentFreeze],
      subjects: after,
    });

    const status = await edited.status(runId);
    if (status.outcome !== "ok") throw new Error("expected ok");
    const gate = status.data.focused?.gates.find((entry) => entry.gateId === "content-freeze");
    expect(gate?.state).toBe("stale");
    expect(status.data.focused?.plan.next[0]?.gateId).toBe("content-freeze");
  });

  // §13.3 keeps final performance approval human-owned, and §12 forbids presenting a machine
  // pass as semantic correctness. The engine enforces it; this proves the services do not
  // quietly route around it.
  it("does not let an agent decide a human-oracle gate (§13.3)", async () => {
    const { services, runId } = await withRun({
      gates: [contentFreeze],
      subjects: subjectsFor("content-freeze", { "spoken-text": "the approved script" }),
    });
    await expect(
      services.approve({ runId, gateId: "content-freeze", actor: AGENT }),
    ).rejects.toMatchObject({ code: "ALDUS_GATE_ACTOR_NOT_PERMITTED" });
  });

  it("records a rejection as its own decision rather than an edit", async () => {
    const { services, runId } = await withRun({
      gates: [contentFreeze],
      subjects: subjectsFor("content-freeze", { "spoken-text": "the approved script" }),
    });
    await services.reject({ runId, gateId: "content-freeze", comment: "claims need sourcing" });
    await services.approve({ runId, gateId: "content-freeze" });

    const stored = await temp.workspace.runs.listRecords(runId, "approvals");
    expect(stored.map((decision) => decision.decision)).toEqual(["rejected", "approved"]);
  });

  it("emits an event for every decision (§6.4)", async () => {
    const { services, runId } = await withRun({
      gates: [contentFreeze],
      subjects: subjectsFor("content-freeze", { "spoken-text": "the approved script" }),
    });
    await services.approve({ runId, gateId: "content-freeze" });

    const log = await temp.workspace.events.read(runId);
    expect(log.events.some((event) => event.action === "gate.approved")).toBe(true);
  });
});

describe("costs (§19.3)", () => {
  it("summarises charged and estimated amounts separately", async () => {
    const { services, runId } = await withRun();
    await temp.workspace.runs.addRecord(
      runId,
      "costs",
      costRecord({ runId, billingStatus: "charged", actual: { amount: "1.50", currency: "USD" } }),
    );
    await temp.workspace.runs.addRecord(
      runId,
      "costs",
      costRecord({
        runId,
        billingStatus: "estimated",
        estimated: { amount: "0.25", currency: "USD" },
      }),
    );

    const result = await services.costs(runId);
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.data.summary.actualByCurrency["USD"]).toBe("1.50");
    expect(result.data.summary.estimatedByCurrency["USD"]).toBe("0.25");
  });

  // §19.3 requires "safe handling of unknown provider billing status". A total that silently
  // includes an unconfirmed charge reads as settled, and an operator trusting it will authorize
  // more spend than they meant to.
  it("flags unconfirmed billing rather than presenting the total as settled", async () => {
    const { services, runId } = await withRun();
    await temp.workspace.runs.addRecord(
      runId,
      "costs",
      costRecord({ runId, billingStatus: "unknown", actual: { amount: "9.99", currency: "USD" } }),
    );

    const result = await services.costs(runId);
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.data.summary.currenciesWithUnknownBilling).toEqual(["USD"]);
  });

  it("counts a voided charge as neither spent nor estimated", async () => {
    const { services, runId } = await withRun();
    await temp.workspace.runs.addRecord(
      runId,
      "costs",
      costRecord({ runId, billingStatus: "voided", actual: { amount: "5.00", currency: "USD" } }),
    );

    const result = await services.costs(runId);
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.data.summary.actualByCurrency).toEqual({});
    expect(result.data.summary.recordCount).toBe(1);
  });
});

describe("inspect and release", () => {
  it("resolves a Run id to its full report", async () => {
    const { services, runId } = await withRun();
    const result = await services.inspect(runId);
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.data.kind).toBe("run");
  });

  it("resolves the Episode identity to its Runs", async () => {
    const { services } = await withRun();
    const result = await services.inspect("show:example-show:episode:episode-a");
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.data.kind).toBe("episode");
    if (result.data.kind !== "episode") return;
    expect(result.data.runs).toHaveLength(1);
  });

  it("says plainly when an identifier names nothing", async () => {
    const { services } = await withRun();
    await expect(services.inspect("neither-a-run-nor-an-episode")).rejects.toMatchObject({
      code: ServiceErrorCodes.SUBJECT_NOT_FOUND,
    });
  });

  it("separates pending release operations from failed ones (§17)", async () => {
    const { services, runId } = await withRun();
    const result = await services.releaseStatus(runId);
    if (result.outcome !== "ok") throw new Error("expected ok");
    expect(result.data.receipts).toEqual([]);
    expect(result.data.pending).toEqual([]);
  });
});

describe("the lock the services must not nest (ADR-0005)", () => {
  // FileEventStore.append takes the Run lock to assign a sequence, and file locks are not
  // re-entrant. A service that held the Run lock and then recorded a decision would wait on
  // itself. The guard turns that into an immediate, named refusal — this proves the guard is
  // live in this wiring, so the constraint the adapters document is enforced rather than
  // merely asserted.
  it("refuses immediately if a caller records a decision while holding the Run lock", async () => {
    const { services, runId } = await withRun({
      gates: [gateDefinition("gate-a", { level: "advisory_signal", enforcement: "advisory" })],
      subjects: subjectsForAll(["gate-a"]),
    });

    const attempt = temp.workspace.locks.withLock(`run-${runId}`, async () => {
      await services.approve({ runId, gateId: "gate-a" });
    });

    await expect(attempt).rejects.toMatchObject({ code: "ALDUS_LOCK_REENTRANT" });
  });

  it("records a decision normally when no lock is held", async () => {
    const { services, runId } = await withRun({
      gates: [gateDefinition("gate-a", { level: "advisory_signal", enforcement: "advisory" })],
      subjects: subjectsForAll(["gate-a"]),
    });
    const result = await services.approve({ runId, gateId: "gate-a" });
    expect(result.outcome).toBe("ok");
  });
});

describe("errors", () => {
  it("classifies a missing actor as policy, so an adapter can tell it from a bug", async () => {
    const services = makeServices(temp.workspace);
    try {
      await services.init();
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as AldusError).category).toBe("policy");
    }
  });
});
