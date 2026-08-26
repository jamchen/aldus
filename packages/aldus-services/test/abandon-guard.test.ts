/**
 * `abandonDispatch` refuses every state except the stuck one (#226).
 *
 * The verb exists for a reservation left `reserved` by a process that died before any billing
 * outcome. Offering it for the other states would put a second door on `settle`'s job, and offering
 * it for a terminal reservation would reopen one ADR-0044 closed on purpose. These drive the real
 * services against a real store, because the guard reads the projection the store produces.
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type SpendReservationTransition } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";

import type { AldusServices } from "../src/services.js";

import { OPERATOR, makeServices, makeTempWorkspace, type TempWorkspace } from "./helpers.js";

let temp: TempWorkspace;

beforeEach(async () => {
  temp = await makeTempWorkspace();
});

afterEach(async () => {
  await temp.cleanup();
});

const GRANT = "grant:run-a:agent:decision-a";
const RESERVATION = "res-a";

/**
 * Seed a reservation stream through the store's own writer.
 *
 * Written this way rather than as commit files, because the store validates revision continuity
 * and a hand-built stream tests the fixture. The dispatch path cannot produce these states on
 * demand — a `reserved` reservation left behind is what a *killed* process leaves, and a test
 * cannot kill itself halfway through a commit.
 */
async function seedStream(kinds: readonly string[]): Promise<void> {
  const store = new FileSpendReservationStore({
    root: join(temp.root, "spend", "reservations"),
  });
  for (const [index, kind] of kinds.entries()) {
    const detail =
      kind === "reservation.reserved"
        ? {
            authorizationId: "decision-a",
            operation: "agent.execute",
            runId: "run-a",
            stageId: "script.draft",
            attemptId: "att-1",
            effectKey: "att-1:draft",
            reserved: { amount: "12.00", currency: "USD" },
          }
        : { costIds: [] };
    const result = await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: index,
      transitions: [
        {
          schemaVersion: SCHEMA_VERSION,
          transitionId: `${RESERVATION}:${kind}`,
          reservationId: RESERVATION,
          grantId: GRANT,
          kind,
          at: "2026-08-26T15:04:42.138Z",
          detail,
        } as unknown as SpendReservationTransition,
      ],
    });
    if (result.kind !== "appended") throw new Error(`seed failed at ${kind}: ${result.kind}`);
  }
}

async function withRun(): Promise<AldusServices> {
  const services = makeServices(temp.workspace, { actor: OPERATOR });
  await services.init({ episode: { showId: "example-show", slug: "episode-a" } });
  const started = await services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: "run-a",
  });
  if (started.outcome !== "ok") throw new Error("failed to start a run");
  return services;
}

describe("only a stuck reservation can be abandoned", () => {
  it("abandons one left `reserved` by a dispatch that never reported", async () => {
    // The positive control. Without it the refusals below could be measuring a verb that refuses
    // everything, which would pass every negative case and be useless.
    const services = await withRun();
    await seedStream(["reservation.reserved", "reservation.dispatch_prepared"]);

    const result = await services.abandonDispatch({
      runId: "run-a",
      reservationId: RESERVATION,
      reason: "the process was killed mid-dispatch",
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.status).toBe("billing_unknown");
  });

  it("refuses one already `billing_unknown`, and names `settle` instead", async () => {
    const services = await withRun();
    await seedStream(["reservation.reserved", "reservation.billing_unknown"]);

    const result = await services.abandonDispatch({
      runId: "run-a",
      reservationId: RESERVATION,
      reason: "killed",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.explanation).toContain("costs settle");
  });

  it("refuses a terminal one, which ADR-0044 closed on purpose", async () => {
    const services = await withRun();
    await seedStream(["reservation.reserved", "reservation.released"]);

    const result = await services.abandonDispatch({
      runId: "run-a",
      reservationId: RESERVATION,
      reason: "killed",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.explanation).toContain("never resumes");
  });

  it("refuses a blank reason before it looks anything up", async () => {
    // Ordered deliberately: an operator who forgot `--reason` is told that, not that a reservation
    // they spelled correctly could not be found.
    const services = await withRun();
    await seedStream(["reservation.reserved"]);

    const result = await services.abandonDispatch({
      runId: "run-a",
      reservationId: RESERVATION,
      reason: "   ",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("reason_required");
  });
});
