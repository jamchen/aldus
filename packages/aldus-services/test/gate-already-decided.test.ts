/**
 * A gate already decided over the same subjects is not asked for twice (contract §13; #275).
 *
 * Reproduced by the first adopter on a real Run. Their refinement stage throws
 * `GateRequiredSignal(gate, { subjectHashes })` whenever its bounded loop did not converge; the
 * operator approved the gate; `inspect` showed it `satisfied`; the stage ran again, threw the same
 * signal for the same gate over the same hashes, and was parked again. #219 made the runner check
 * that the gate is *known*, #241 let a decided gate release the stage parked on it — and nothing
 * checked whether the decision being asked for already existed, because the runner had no gate
 * state and the stage had no port.
 *
 * This suite measures the **wiring**: the gate engine's judgement, read through the same subjects
 * provider `approve` and `status` use, reaching both the runner's arm and `context.gateStatus`.
 * The runner's own rule has its own tests in `@aldus-runtime/stage-runner`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digestSubjectValue } from "@aldus-runtime/gate-engine";
import {
  GateRequiredSignal,
  type StageDefinition,
  type StageGateStatus,
  type StageOutcome,
} from "@aldus-runtime/stage-runner";

import type { AldusServices } from "../src/services.js";

import {
  OPERATOR,
  gateDefinition,
  makeServices,
  makeTempWorkspace,
  registryOf,
  subjectsForAll,
  type TempWorkspace,
} from "./helpers.js";

const GATE = "content-freeze";
const STAGE = "script.refine";
/** What `subjectsForAll([GATE])` supplies, and therefore what `approve` binds. */
const BOUND_HASH = digestSubjectValue("value-a");
const OTHER_HASH = digestSubjectValue("value-b");

let temp: TempWorkspace;

beforeEach(async () => {
  temp = await makeTempWorkspace();
});

afterEach(async () => {
  await temp.cleanup();
});

async function withRun(options: Parameters<typeof makeServices>[1]): Promise<{
  services: AldusServices;
  runId: string;
}> {
  const services = makeServices(temp.workspace, { actor: OPERATOR, ...options });
  await services.init({ episode: { showId: "example-show", slug: "episode-a" } });
  const started = await services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: "run-a",
  });
  if (started.outcome !== "ok") throw new Error("could not start a Run");
  return { services, runId: started.data.run.runId };
}

const anySchema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };

/** The adopter's shape: throws for the gate unconditionally, over the hashes it was given. */
function throwingStage(subjectHashes: readonly string[]): StageDefinition<unknown, unknown> {
  return {
    id: STAGE,
    version: "1",
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" },
    execute: (): Promise<StageOutcome<unknown>> => {
      throw new GateRequiredSignal(GATE, { subjectHashes });
    },
  };
}

/** What the last `askingStage` was told, so the wiring is observable from outside the stage. */
let seen: StageGateStatus | undefined | "unasked";

/** A stage that asks the port and records the answer. */
function askingStage(gateId: string): StageDefinition<unknown, unknown> {
  return {
    id: STAGE,
    version: "1",
    inputSchema: anySchema,
    outputSchema: anySchema,
    requiredCapabilities: [],
    artifacts: { produces: "none" },
    retrySafety: { kind: "no_external_effects" },
    execute: async (context): Promise<StageOutcome<unknown>> => {
      seen = await context.gateStatus?.(gateId);
      return { kind: "completed", output: {} };
    },
  };
}

describe("the runner's arm, wired to the gate engine (#275)", () => {
  it("parks while the gate is undecided", async () => {
    // The control, first: the case below has to be measuring a refusal that exists only once the
    // gate is decided, not a runner that refuses every signal.
    const { services, runId } = await withRun({
      stages: registryOf(throwingStage([BOUND_HASH])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    const parked = await services.runStage({ runId, stageId: STAGE });

    expect(parked.outcome).toBe("unsuccessful");
    if (parked.outcome !== "unsuccessful") return;
    expect(parked.data.status).toBe("waiting_for_gate");
  });

  it("refuses with ALDUS_GATE_ALREADY_DECIDED once the gate is approved over the same subjects", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(throwingStage([BOUND_HASH])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });
    await services.runStage({ runId, stageId: STAGE });
    await services.approve({ runId, gateId: GATE });

    // #241 releases the parked stage; the stage runs, and throws the same signal again.
    const again = await services.runStage({ runId, stageId: STAGE });

    expect(again.outcome).toBe("unsuccessful");
    if (again.outcome !== "unsuccessful") return;
    expect(again.data.status).toBe("failed");
    expect(again.data.error?.code).toBe("ALDUS_GATE_ALREADY_DECIDED");
    expect(again.data.error?.message).toContain(`gate "${GATE}"`);
    expect(again.data.error?.message).toContain(`Stage "${STAGE}"`);
  });

  it("parks again when the gate is approved over different subjects", async () => {
    // The negative control for the hash comparison, measured through the real engine: the
    // operator approved `value-a`, the stage asks about `value-b`, and that is a new question.
    const { services, runId } = await withRun({
      stages: registryOf(throwingStage([OTHER_HASH])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });
    await services.runStage({ runId, stageId: STAGE });
    await services.approve({ runId, gateId: GATE });

    const again = await services.runStage({ runId, stageId: STAGE });

    expect(again.outcome).toBe("unsuccessful");
    if (again.outcome !== "unsuccessful") return;
    expect(again.data.status).toBe("waiting_for_gate");
  });

  it("parks again after a rejection, which the stage must surface as its own outcome", async () => {
    // A rejection is a decision — #241 releases the stage — but not a satisfied gate, so the
    // runner does not refuse the signal. What a stage does with a rejection is the stage's
    // business, and `context.gateStatus` is how it finds out.
    const { services, runId } = await withRun({
      stages: registryOf(throwingStage([BOUND_HASH])),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });
    await services.runStage({ runId, stageId: STAGE });
    await services.reject({ runId, gateId: GATE });

    const again = await services.runStage({ runId, stageId: STAGE });

    expect(again.outcome).toBe("unsuccessful");
    if (again.outcome !== "unsuccessful") return;
    expect(again.data.status).toBe("waiting_for_gate");
  });
});

describe("context.gateStatus, wired to the gate engine (#275)", () => {
  beforeEach(() => {
    seen = "unasked";
  });

  async function askedStatus(
    services: AldusServices,
    runId: string,
  ): Promise<StageGateStatus | undefined> {
    const result = await services.runStage({ runId, stageId: STAGE });
    if (result.outcome !== "ok") throw new Error(`expected ok, got ${result.outcome}`);
    if (seen === "unasked") throw new Error("the stage did not run");
    return seen;
  }

  it("reports a pending gate as unsatisfied with no bound hashes", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(askingStage(GATE)),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    expect(await askedStatus(services, runId)).toEqual({ satisfied: false, state: "pending" });
  });

  it("reports an approved gate as satisfied over the hashes the decision binds", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(askingStage(GATE)),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });
    await services.approve({ runId, gateId: GATE });

    expect(await askedStatus(services, runId)).toEqual({
      satisfied: true,
      state: "satisfied",
      subjectHashes: [BOUND_HASH],
    });
  });

  it("reports a rejected gate by its state, so a stage can tell it from undecided", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(askingStage(GATE)),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });
    await services.reject({ runId, gateId: GATE });

    expect(await askedStatus(services, runId)).toEqual({
      satisfied: false,
      state: "rejected",
      subjectHashes: [BOUND_HASH],
    });
  });

  it("answers undefined for a gate no registry knows, rather than throwing at a read", async () => {
    const { services, runId } = await withRun({
      stages: registryOf(askingStage("conten-freeze")),
      gates: [gateDefinition(GATE)],
      subjects: subjectsForAll([GATE]),
    });

    expect(await askedStatus(services, runId)).toBeUndefined();
  });
});
