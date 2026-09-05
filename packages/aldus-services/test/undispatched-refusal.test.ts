/**
 * A refusal that never dispatched must not leave authorization held (#283).
 *
 * Measured driving a real paid dispatch: a backend refused by an adopter-side ceiling *before*
 * spawning anything, and the reservation survived as `billing_unknown` holding its full reserved
 * amount — which then refused every later dispatch on the grant. The runtime could not tell that
 * refusal from a backend that threw halfway through a billed request, because the backend had no
 * way to say which had happened.
 *
 * The channel is a declaration, never an inference: `undispatched()` on a thrown error, or
 * `dispatched: false` on a returned result. Absent either, a failure stays unknown.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileSpendReservationStore } from "@aldus-runtime/file-store";

import type { ActorRef, AldusEvent, CostRecord } from "@aldus-runtime/core";
import type { SpendGrant } from "@aldus-runtime/gate-engine";
import { undispatched, type AgentBackend } from "@aldus-runtime/stage-runner";

import { AgentExecutionService } from "../src/agent-execution.js";
import type { CostRecordStore } from "../src/cost-store.js";
import { SpendService } from "../src/spend-service.js";

const ACTOR: ActorRef = { kind: "agent", id: "agent-a" };
const RUN = "run-a";

const GRANT: SpendGrant = {
  grantId: "grant-1",
  runId: RUN,
  gateId: "performance.freeze",
  decisionId: "decision-7",
  scope: { operations: ["agent.execute"] },
  maxTotal: { amount: "10.00", currency: "USD" },
  maxPerRequest: { amount: "2.00", currency: "USD" },
};

function costStore(): CostRecordStore & { records: CostRecord[] } {
  const records: CostRecord[] = [];
  return {
    records,
    list: () => Promise.resolve([...records]),
    append: (_runId, record) => {
      records.push(record);
      return Promise.resolve();
    },
  };
}

function eventSink(): {
  append(runId: string, event: AldusEvent): Promise<void>;
  events: AldusEvent[];
} {
  const events: AldusEvent[] = [];
  return {
    events,
    append: (_runId, event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

function backend(overrides: Partial<AgentBackend> = {}): AgentBackend {
  return {
    id: "backend-a",
    version: "1.0.0",
    capabilities: () => Promise.resolve({ offers: [], interactive: false, resumable: false }),
    execute: () => Promise.resolve({ ok: true }),
    ...overrides,
  };
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "aldus-undispatched-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function serviceWith(agentBackend: AgentBackend) {
  const costs = costStore();
  const events = eventSink();
  // A real store against a real filesystem: the reservation path is the thing under test.
  const spend = new SpendService({
    store: new FileSpendReservationStore({ root: tempRoot }),
    costs,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const service = new AgentExecutionService({
    backend: agentBackend,
    spend,
    costs,
    events,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { service, costs, events, spend };
}

const base = {
  runId: RUN,
  operation: "agent.execute",
  effectKey: "effect-a",
  expectation: { kind: "estimated", amount: { amount: "1.00", currency: "USD" } } as const,
  episodeId: "episode-a",
  stageId: "outline.draft",
  attemptId: "att-1",
  actor: ACTOR,
  request: { prompt: "draft it" } as never,
};

describe("a declared pre-dispatch refusal releases its reservation", () => {
  it("holds nothing after a backend refuses before spawning, and leaves the grant spendable", async () => {
    const { service, spend, costs } = serviceWith(
      backend({
        execute: () =>
          Promise.reject(
            undispatched("the workspace ceiling is already exceeded, so nothing was spawned"),
          ),
      }),
    );

    await expect(service.execute({ ...base, grant: GRANT })).rejects.toThrow(/nothing was spawned/);

    const statuses = await spend.status(RUN);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.status).toBe("released");
    expect(statuses[0]?.requiresReconciliation).toBe(false);
    // Nothing ran, so nothing is charged and no record claims otherwise.
    expect(costs.records).toHaveLength(0);

    // The grant is spendable again: a second effect reserves and settles.
    const second = await serviceWith(
      backend({
        execute: () =>
          Promise.resolve({
            ok: true,
            costs: [
              {
                provider: "provider-a",
                operation: "agent.execute",
                actual: { amount: "0.50", currency: "USD" },
                billingStatus: "charged" as const,
              },
            ],
          }),
      }),
    );
    const outcome = await second.service.execute({
      ...base,
      effectKey: "effect-b",
      attemptId: "att-2",
      grant: GRANT,
    });
    expect(outcome.costs).toHaveLength(1);
  });

  it("releases when the refusal comes back as a result rather than a throw", async () => {
    const { service, spend } = serviceWith(
      backend({
        execute: () =>
          Promise.resolve({
            ok: false,
            dispatched: false,
            error: {
              code: "CEILING_EXCEEDED",
              message: "nothing was spawned",
              category: "policy",
            } as never,
          }),
      }),
    );

    const outcome = await service.execute({ ...base, grant: GRANT });

    expect(outcome.result.ok).toBe(false);
    expect(outcome.billingUnconfirmed).toBe(false);
    const statuses = await spend.status(RUN);
    expect(statuses[0]?.status).toBe("released");
  });

  it("still holds when a backend throws without declaring that nothing was dispatched", async () => {
    // The guard on the guard. A failure is not evidence of no charge, and the release must come
    // from the backend's declaration rather than from the fact that something went wrong.
    const { service, spend } = serviceWith(
      backend({ execute: () => Promise.reject(new Error("connection reset")) }),
    );

    await expect(service.execute({ ...base, grant: GRANT })).rejects.toThrow(/connection reset/);

    const statuses = await spend.status(RUN);
    expect(statuses[0]?.status).toBe("billing_unknown");
    expect(statuses[0]?.requiresReconciliation).toBe(true);
  });
});
