/**
 * What the takeover refusal tells an operator about spending (#244, ADR-0044).
 *
 * The refusal for a `running` stage reported two entirely different situations identically: a
 * stage whose authorization was committed and whose provider was never called, and one that may
 * already have been billed. `docs/design/spend-reservation-store.md` §5 records the difference
 * durably and nothing here was reading it.
 *
 * What must **not** change is the friction. `--force` is required in every answer below, the error
 * code, category and `retryable` are the same in every answer, and the message for a runner with
 * no port wired is byte-identical to the one before this existed.
 */

import type { AldusError, StageDispatchEvidence } from "@aldus-runtime/core";
import { afterEach, describe, expect, it } from "vitest";

import { StageRunnerErrorCodes } from "../src/errors.js";
import { aStage, makeTempRun, type TempRun } from "./helpers.js";

let harness: TempRun;

afterEach(async () => {
  await harness.cleanup();
});

/**
 * Leave `stage-a` claimed by a runner that never returns, then take the refusal.
 *
 * Synchronised on the stage entering `execute` rather than on a sleep, for the reason recorded in
 * `runner.test.ts`: the refusal can otherwise be satisfied from the appended event while the
 * `stages.json` write is still in flight, and cleanup then races a real write (#255).
 */
async function refusalWith(
  evidence: StageDispatchEvidence | "unwired" | "throws",
): Promise<AldusError> {
  harness = await makeTempRun(
    evidence === "unwired"
      ? {}
      : {
          stageSpendEvidence: () =>
            evidence === "throws"
              ? Promise.reject(new Error("the store could not be read"))
              : Promise.resolve(evidence),
        },
  );

  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  harness.registry.register(
    aStage({
      execute: async () => {
        entered();
        return await new Promise<never>(() => {});
      },
    }),
  );
  void harness.runner.run(harness.manifest.runId, "stage-a", {});
  await running;

  try {
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
  } catch (error) {
    return error as AldusError;
  }
  throw new Error("expected the second run to be refused");
}

/** The message as it stood before a spend port existed, and as it must still stand unwired. */
const MESSAGE_BEFORE_THIS_CHANGE =
  'Stage "stage-a" is already running. If the runner that claimed it died, pass `--force` to ' +
  "take over — `aldus run <stage> --run <id> --force`, or `force: true` from a program. " +
  "Deliberate by design, because assuming a running stage is dead would let two runners execute " +
  "one side-effecting stage at once (contract §19.1). This runner cannot tell what the stuck " +
  "attempt did: artifacts reach the record when a stage settles and this one has not, and it " +
  "holds no cost store — so an empty attempt is not evidence that nothing happened. " +
  "`aldus costs --run <id>` shows what the Run holds.";

describe("a runner with no spend port keeps today's message", () => {
  it("emits it byte for byte", async () => {
    // Not `toContain`, and not a regex. The rule is that an unwired runner's operator sees no
    // change at all, and only equality states that. A transcribed literal is the weak part of this
    // test — it is checked against the source string, one line above, rather than trusted.
    const error = await refusalWith("unwired");
    expect(error.message).toBe(MESSAGE_BEFORE_THIS_CHANGE);
  });

  it("records `indeterminate` rather than leaving the reader to guess which row applied", async () => {
    const error = await refusalWith("unwired");
    expect(error.details).toMatchObject({ dispatchEvidence: "indeterminate" });
  });
});

describe("a port that declines is not a port that answered", () => {
  it("keeps today's message when the read throws", async () => {
    // `DECLINED` is a state, never folded into either other. A store that could not be read must
    // never leave this method as the row saying no provider call was begun.
    const error = await refusalWith("throws");
    expect(error.message).toBe(MESSAGE_BEFORE_THIS_CHANGE);
  });

  it("keeps today's message when the port answers `indeterminate`", async () => {
    const error = await refusalWith("indeterminate");
    expect(error.message).toBe(MESSAGE_BEFORE_THIS_CHANGE);
  });

  it("does not let a throwing port break the refusal itself", async () => {
    // The refusal is the safety property; the sentence is an improvement to it. A port that
    // explodes must not turn a refusal into a takeover.
    const error = await refusalWith("throws");
    expect(error.code).toBe(StageRunnerErrorCodes.STAGE_STATE_INVALID);
  });
});

describe("the safe row — committed authorization, no dispatch recorded", () => {
  it("says every reservation the Run holds for the stage records no dispatch", async () => {
    const error = await refusalWith("reserved_never_dispatched");
    expect(error.message).toContain("none records a dispatch");
  });

  it("states it as a fact about the store, never about the world", async () => {
    // The Owner's second constraint, and the line that keeps this sentence from contradicting the
    // one above it: absence of a second reservation is not evidence there was no second effect.
    const error = await refusalWith("reserved_never_dispatched");
    expect(error.message).toContain(
      "a fact about this workspace's reservation store, not about every effect the attempt could " +
        "have had",
    );
  });

  it("never says nothing happened, and keeps the sentence that says why it cannot", async () => {
    const error = await refusalWith("reserved_never_dispatched");
    // The preserved half still states the limit.
    expect(error.message).toContain("an empty attempt is not evidence that nothing happened");
    // And the appended half — examined on its own, because the preserved sentence contains the
    // words a naive search would find — claims nothing the store cannot support. "Nothing was
    // spent" and "nothing happened" are claims about the world; this row is a claim about a store.
    const appended = error.message.slice(MESSAGE_BEFORE_THIS_CHANGE.length);
    expect(appended).not.toContain("nothing was spent");
    expect(appended).not.toContain("nothing happened");
    expect(appended).not.toContain("safe to");
  });

  it("still requires --force, and says so", async () => {
    // The row where lowering the friction would be most tempting is the row this has to hold in.
    const error = await refusalWith("reserved_never_dispatched");
    expect(error.message).toContain("pass `--force` to take over");
  });
});

describe("the dispatch row — a paid call may already have gone out", () => {
  it("says a dispatch was prepared and the call may have been billed", async () => {
    const error = await refusalWith("dispatch_possible");
    expect(error.message).toContain("may already have been billed");
  });

  it("warns that taking over may repeat a paid call", async () => {
    const error = await refusalWith("dispatch_possible");
    expect(error.message).toContain("Taking over may repeat a paid call");
  });

  it("does not carry the safe row's clause", async () => {
    // Anchored on the distinguishing clause rather than on a substring both rows satisfy — #246's
    // surviving mutation was exactly that mistake.
    const error = await refusalWith("dispatch_possible");
    expect(error.message).not.toContain("none records a dispatch");
  });
});

describe("what no row changes", () => {
  const rows = [
    "unwired",
    "indeterminate",
    "reserved_never_dispatched",
    "dispatch_possible",
  ] as const;

  for (const row of rows) {
    it(`keeps the code, category, retryability and the --force requirement for "${row}"`, async () => {
      const error = await refusalWith(row);
      expect(error.code).toBe(StageRunnerErrorCodes.STAGE_STATE_INVALID);
      expect(error.category).toBe("conflict");
      expect(error.retryable).toBe(true);
      expect(error.message).toContain("pass `--force` to take over");
      expect(error.message).toContain("aldus costs --run");
    });
  }

  for (const row of ["reserved_never_dispatched", "dispatch_possible"] as const) {
    it(`lets --force through in the "${row}" row, unchanged`, async () => {
      // The verdict changes what an operator is told, never what they may do — in both directions.
      // The safe row must not become an automatic takeover, and the dispatch row must not become a
      // second refusal an operator holding the flag cannot get past.
      harness = await makeTempRun({ stageSpendEvidence: () => Promise.resolve(row) });

      let entered!: () => void;
      const running = new Promise<void>((resolve) => {
        entered = resolve;
      });
      // The first claim never returns — a runner killed mid-flight. A later one completes, which
      // is what a takeover is: the same stage, run again by somebody else.
      let claims = 0;
      harness.registry.register(
        aStage({
          execute: async () => {
            claims += 1;
            if (claims > 1) return { kind: "completed", output: {} };
            entered();
            return await new Promise<never>(() => {});
          },
        }),
      );
      void harness.runner.run(harness.manifest.runId, "stage-a", {});
      await running;

      await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toThrow();

      const result = await harness.runner.run(
        harness.manifest.runId,
        "stage-a",
        {},
        { force: true },
      );
      expect(result.status).toBe("succeeded");
    });
  }

  it("asks the port exactly once, with the Run and stage under refusal", async () => {
    // Not the attempt id, which a reservation does not reliably carry after a retry, and not more
    // than once — a refusal that reads the store repeatedly is a refusal whose cost grows with the
    // size of the ledger.
    const calls: Array<[string, string]> = [];
    harness = await makeTempRun({
      stageSpendEvidence: (runId, stageId) => {
        calls.push([runId, stageId]);
        return Promise.resolve("reserved_never_dispatched");
      },
    });

    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    harness.registry.register(
      aStage({
        execute: async () => {
          entered();
          return await new Promise<never>(() => {});
        },
      }),
    );
    void harness.runner.run(harness.manifest.runId, "stage-a", {});
    await running;

    await expect(harness.runner.run(harness.manifest.runId, "stage-a", {})).rejects.toThrow();
    expect(calls).toEqual([[harness.manifest.runId, "stage-a"]]);
  });

  it("is not consulted for a stage that is not running", async () => {
    // The read lives inside the `running && !force` branch. A stage parked on a gate refuses for
    // an entirely different reason, and reading the spend store to answer it would be a cost with
    // no question behind it.
    let consulted = 0;
    harness = await makeTempRun({
      stageSpendEvidence: () => {
        consulted += 1;
        return Promise.resolve("reserved_never_dispatched");
      },
    });
    harness.registry.register(aStage({ execute: async () => ({ kind: "completed", output: {} }) }));
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    expect(consulted).toBe(0);
  });
});

describe("two operators refusing at once", () => {
  it("gives both the same message, and neither a takeover", async () => {
    // Idempotent and deterministic under concurrency: the read is a read, so two refusals of one
    // stuck stage cannot disagree and cannot let a second runner in.
    harness = await makeTempRun({
      stageSpendEvidence: () => Promise.resolve("dispatch_possible"),
    });

    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    harness.registry.register(
      aStage({
        execute: async () => {
          entered();
          return await new Promise<never>(() => {});
        },
      }),
    );
    void harness.runner.run(harness.manifest.runId, "stage-a", {});
    await running;

    const results = await Promise.allSettled([
      harness.runner.run(harness.manifest.runId, "stage-a", {}),
      harness.runner.run(harness.manifest.runId, "stage-a", {}),
    ]);
    const messages = results.map((result) =>
      result.status === "rejected" ? (result.reason as AldusError).message : "SUCCEEDED",
    );
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toContain("Taking over may repeat a paid call");
  });
});
