import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type SpendReservationTransition } from "@aldus-runtime/core";
import { FileSpendReservationStore } from "@aldus-runtime/file-store";

import type { CliOptions, TempWorkspace } from "./helpers.js";
import { invoke, makeTempWorkspace } from "./helpers.js";

/**
 * The remedy `costs` prints must be a command that resolves the state it is printed for (#283).
 *
 * Measured driving a real paid dispatch: `costs` printed
 * `aldus costs settle <reservation-id> --evidence <what it rests on>`, the operator ran exactly
 * that, and the answer was `Reservation … is now billing_unknown` — the status it already had, the
 * hold still standing, the grant still refusing every later dispatch. It exited zero, so it read as
 * success and the operator went looking elsewhere.
 *
 * These run the **printed string**, parsed out of the CLI's own stdout, rather than asserting that
 * a flag exists. A test that checked for `--uncharged` in the source would have passed on the day
 * the printed line omitted it.
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

/** A reservation in the state the adopter's grant was stuck in: unresolved, holding its full sum. */
async function seedUnresolvedCharge(root: string, runId: string): Promise<void> {
  const grantId = `grant:${runId}:agent:decision-a`;
  const store = new FileSpendReservationStore({ root: join(root, "spend", "reservations") });
  const transition = (
    kind: string,
    detail: Record<string, unknown>,
    at: string,
  ): SpendReservationTransition =>
    ({
      schemaVersion: SCHEMA_VERSION,
      transitionId: `res-a:${kind}`,
      reservationId: "res-a",
      grantId,
      kind,
      at,
      detail,
    }) as unknown as SpendReservationTransition;

  const result = await store.compareAndAppend({
    grantId,
    expectedRevision: 0,
    transitions: [
      transition(
        "reservation.reserved",
        {
          authorizationId: "decision-a",
          operation: "agent.execute",
          runId,
          stageId: "script.draft",
          attemptId: "att-1",
          effectKey: "att-1:draft",
          // The grant's per-request maximum, which is what an unestimated execution reserves.
          reserved: { amount: "12.00", currency: "USD" },
        },
        "2026-08-27T00:00:00.000Z",
      ),
      transition(
        "reservation.billing_unknown",
        { costIds: [], reason: "the dispatch returned no billing observations" },
        "2026-08-27T00:00:01.000Z",
      ),
    ],
  });
  if (result.kind !== "appended") throw new Error(`seed failed: ${result.kind}`);
}

/**
 * The releasing command out of the printed listing, as argv.
 *
 * Takes the `--uncharged` line the CLI printed and fills only the operator's own words — the
 * evidence. Nothing else is edited: an edit here is the test quietly repairing the string under
 * test, which is exactly the defect.
 */
function printedRemedy(stdout: string): string[] {
  const line = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.startsWith("aldus costs settle ") && candidate.endsWith("--uncharged"),
    );
  if (line === undefined) throw new Error(`no releasing remedy printed:\n${stdout}`);
  return line
    .replace(/^aldus /, "")
    .replace("<what it rests on>", "PLACEHOLDER_EVIDENCE")
    .split(" ")
    .map((token) => (token === "PLACEHOLDER_EVIDENCE" ? "the provider shows no request" : token));
}

describe("the command `costs` prints is one that releases the hold", () => {
  it("resolves the reservation when run exactly as printed", async () => {
    const runId = await seed(base);
    await seedUnresolvedCharge(temp.root, runId);

    const listed = await invoke(base, "costs", "--run", runId);
    expect(listed.stdout).toContain("res-a");
    expect(listed.stdout).toContain("unresolved charge(s)");

    const settle = await invoke(base, ...printedRemedy(listed.stdout), "--run", runId);

    // Not merely a zero exit: the previous remedy exited zero too, and printed the status the
    // reservation already had.
    expect(settle.stdout).toContain("res-a is now released");
    expect(settle.stdout).not.toContain("billing_unknown");

    const after = await invoke(base, "costs", "--run", runId);
    expect(after.stdout).not.toContain("unresolved charge(s)");
  });

  it("names the amount held as authorization rather than as a charge", async () => {
    // 12.00 against a stage that has never cost above 1.43 is the unestimated-execution policy
    // reserving the grant's per-request maximum, not a measurement of anything.
    const runId = await seed(base);
    await seedUnresolvedCharge(temp.root, runId);

    const listed = await invoke(base, "costs", "--run", runId);

    expect(listed.stdout).toContain("holds 12.00 USD");
    expect(listed.stdout).toContain("not a measured charge");
  });
});

describe("`costs settle` refuses a call that names no disposition", () => {
  it("says which flag it needs rather than reporting success", async () => {
    const runId = await seed(base);
    await seedUnresolvedCharge(temp.root, runId);

    const result = await invoke(
      base,
      "costs",
      "settle",
      "res-a",
      "--run",
      runId,
      "--evidence",
      "the provider shows no request",
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--amount");
    expect(result.stderr).toContain("--uncharged");
    expect(result.stderr).toContain("--investigation-ended");
    // The state it refused to touch is still the state it was in, and still visible.
    expect((await invoke(base, "costs", "--run", runId)).stdout).toContain("unresolved charge(s)");
  });

  it("still records an audit-only finding when the operator asks for one", async () => {
    // The negative control. Requiring a disposition must not remove the third resolution; it must
    // stop it being what an operator gets by omitting a flag.
    const runId = await seed(base);
    await seedUnresolvedCharge(temp.root, runId);

    const result = await invoke(
      base,
      "costs",
      "settle",
      "res-a",
      "--run",
      runId,
      "--evidence",
      "the provider's console shows no request for that window",
      "--investigation-ended",
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("billing_unknown");
  });
});
