import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type SpendReservationTransition } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";

import type { CliOptions, TempWorkspace } from "./helpers.js";
import { invoke, makeTempWorkspace } from "./helpers.js";

/**
 * `costs abandon` — the verb a stranded reservation had no way to reach (#226).
 *
 * A process killed between `reserve` and any billing outcome leaves the reservation `reserved`:
 * nothing survived to classify it, so it never became `billing_unknown`, and `costs settle` accepts
 * only `billing_unknown`. The first adopter's `aldus costs` listed a reservation holding $12.00 and
 * named `costs settle` as its resolution, and `settle` refused it — the one place that tells an
 * operator what to do naming the one command that would refuse them.
 */

let temp: TempWorkspace;
let base: CliOptions;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  base = { root: temp.root, env: { ALDUS_ACTOR: "human:operator-a" } };
});

afterEach(async () => {
  await temp.cleanup();
});

async function seed(options: CliOptions): Promise<string> {
  await invoke(options, "init", "--show", "example-show", "--slug", "episode-a");
  const started = await invoke(
    options,
    "start",
    "--workflow",
    "workflow-a",
    "--workflow-version",
    "1",
    "--json",
  );
  return (started.json() as { data: { run: { runId: string } } }).data.run.runId;
}

describe("the verb exists and states its own preconditions", () => {
  it("needs a reservation id", async () => {
    const runId = await seed(base);
    const result = await invoke(base, "costs", "abandon", "--run", runId);
    expect(result.stderr).toContain("needs a reservation id");
  });

  it("requires --verbatim with --decided-by", async () => {
    const runId = await seed(base);
    const result = await invoke(
      base,
      "costs",
      "abandon",
      "res-x",
      "--run",
      runId,
      "--reason",
      "killed mid-dispatch",
      "--decided-by",
      "human:jamchen",
    );
    expect(result.stderr).toContain("needs `--verbatim`");
  });

  it("refuses without a reason, because an unattributed abandon is indistinguishable", async () => {
    // A reservation moved out of `reserved` with no stated reason reads exactly like one the
    // runtime classified itself, which is the distinction the verb exists to make.
    const runId = await seed(base);
    const result = await invoke(base, "costs", "abandon", "res-x", "--run", runId);
    expect(result.stderr).toContain("needs a reason");
  });

  it("says which reservation it could not find rather than failing opaquely", async () => {
    const runId = await seed(base);
    const result = await invoke(
      base,
      "costs",
      "abandon",
      "res-missing",
      "--run",
      runId,
      "--reason",
      "killed mid-dispatch",
    );
    expect(result.stderr).toContain("res-missing");
  });

  it("leaves `costs show` and `costs settle` reachable", async () => {
    // The control. Adding a second subcommand must not take the default or shadow the first.
    const runId = await seed(base);
    expect((await invoke(base, "costs", "--run", runId)).code).toBe(0);
    expect((await invoke(base, "costs", "show", "--run", runId)).code).toBe(0);
    expect((await invoke(base, "costs", "settle", "--run", runId)).stderr).toContain(
      "needs a reservation id",
    );
  });
});

describe("the printed remedy is one the invoking actor may run", () => {
  // Reported by the first adopter from the first real use: `costs` printed `aldus costs abandon …`,
  // they ran exactly that as `ALDUS_ACTOR=agent:coordinator`, and got
  // `SPEND_NOT_AUTHORIZED: reconciliation is a human decision`. The refusal is right; the listing
  // told the current actor to run a command the current actor may not run.
  //
  // End to end through the CLI rather than against `renderCosts` directly, because the unit tests
  // pass the actor kind in by hand and therefore cannot see the CLI failing to pass it at all.
  // That mutation — dropping `options.actor?.kind` at the call site — survived every other test in
  // this package.
  async function seedHeldReservation(root: string, runId: string): Promise<void> {
    const grantId = `grant:${runId}:agent:decision-a`;
    const store = new FileSpendReservationStore({
      root: join(root, "spend", "reservations"),
    });
    const result = await store.compareAndAppend({
      grantId,
      expectedRevision: 0,
      transitions: [
        {
          schemaVersion: SCHEMA_VERSION,
          transitionId: "res-a:reservation.reserved",
          reservationId: "res-a",
          grantId,
          kind: "reservation.reserved",
          at: "2026-08-27T00:00:00.000Z",
          detail: {
            authorizationId: "decision-a",
            operation: "agent.execute",
            runId,
            stageId: "script.draft",
            attemptId: "att-1",
            effectKey: "att-1:draft",
            reserved: { amount: "12.00", currency: "USD" },
          },
        } as unknown as SpendReservationTransition,
      ],
    });
    if (result.kind !== "appended") throw new Error(`seed failed: ${result.kind}`);
  }

  it("tells an agent to transcribe a human's decision", async () => {
    const options: CliOptions = { root: temp.root, env: { ALDUS_ACTOR: "agent:coordinator" } };
    const runId = await seed(options);
    await seedHeldReservation(temp.root, runId);

    const result = await invoke(options, "costs", "--run", runId);

    expect(result.stdout).toContain("res-a");
    expect(result.stdout).toContain("--decided-by");
  });

  it("gives a human the plain form", async () => {
    // The control. Printing the clause to everyone would make it noise a human learns to skip,
    // which is how a hint stops working on the day it matters.
    const runId = await seed(base);
    await seedHeldReservation(temp.root, runId);

    const result = await invoke(base, "costs", "--run", runId);

    expect(result.stdout).toContain("res-a");
    expect(result.stdout).not.toContain("--decided-by");
  });
});
