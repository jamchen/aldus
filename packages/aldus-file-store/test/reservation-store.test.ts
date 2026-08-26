/**
 * The reservation store's atomicity (ADR-0044; #155 step 2).
 *
 * The property under test is the one the design pass got wrong first time: a revision comparison
 * followed by an ordinary write is still check-then-act. These drive the real store against a real
 * filesystem, because the failure is in the interleaving rather than in the arithmetic.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type SpendReservationTransition } from "@aldus-runtime/core";

import { FileSpendReservationStore } from "../src/reservation-store.js";

let root: string;
let store: FileSpendReservationStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aldus-reservations-"));
  store = new FileSpendReservationStore({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const GRANT = "grant-a";

function reserved(id: string, overrides: Partial<SpendReservationTransition> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    transitionId: id,
    reservationId: `res-${id}`,
    grantId: GRANT,
    kind: "reservation.reserved",
    at: "2026-01-01T00:00:00.000Z",
    detail: {
      authorizationId: "decision-a",
      operation: "agent.execute",
      runId: "run-a",
      stageId: "stage-a",
      attemptId: "att-1",
      effectKey: `effect-${id}`,
      reserved: { amount: "1.0000", currency: "USD" },
    },
    ...overrides,
  } as SpendReservationTransition;
}

describe("exactly one writer wins a revision", () => {
  it("two writers racing for revision 1 produce one winner and one conflict", async () => {
    // The interleaving the first design permitted. Both read revision 0 and both pass the check;
    // only `link()` decides, and the loser's payload must be absent rather than overwriting.
    const [a, b] = await Promise.all([
      store.compareAndAppend({ grantId: GRANT, expectedRevision: 0, transitions: [reserved("a")] }),
      store.compareAndAppend({ grantId: GRANT, expectedRevision: 0, transitions: [reserved("b")] }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["appended", "conflict"]);

    const stream = await store.readGrant(GRANT);
    expect(stream.revision).toBe(1);
    expect(stream.transitions).toHaveLength(1);
  });

  it("a paused writer resuming after another committed is refused, not allowed to clobber", async () => {
    // A holds a stale expectation — the shape §0 of the design describes.
    await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: 0,
      transitions: [reserved("b")],
    });

    const late = await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: 0,
      transitions: [reserved("a")],
    });

    expect(late.kind).toBe("conflict");
    const stream = await store.readGrant(GRANT);
    // B's transition survived. Under a replacing write it would not have.
    expect(stream.transitions[0]?.transitionId).toBe("b");
  });

  it("revision counts commits, not transitions", async () => {
    // One commit carrying two transitions advances the revision once. Counting transitions would
    // make the expected revision depend on batch shape.
    await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: 0,
      transitions: [reserved("a"), reserved("b")],
    });

    const stream = await store.readGrant(GRANT);
    expect(stream.revision).toBe(1);
    expect(stream.transitions).toHaveLength(2);
  });
});

describe("identity outranks revision", () => {
  it("replaying an identical commit returns already_present, not appended", async () => {
    // The caller that committed and lost the response. Its commit advanced the stream past the
    // revision it still expects; evaluating the revision first would loop it forever.
    const transitions = [reserved("a")];
    await store.compareAndAppend({ grantId: GRANT, expectedRevision: 0, transitions });

    const replay = await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: 0,
      transitions,
    });

    expect(replay.kind).toBe("already_present");
    const stream = await store.readGrant(GRANT);
    expect(stream.revision).toBe(1);
  });

  it("refuses a transition id reused for a different fact", async () => {
    await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: 0,
      transitions: [reserved("a")],
    });

    await expect(
      store.compareAndAppend({
        grantId: GRANT,
        expectedRevision: 1,
        transitions: [reserved("a", { at: "2026-06-01T00:00:00.000Z" })],
      }),
    ).rejects.toThrow(/different contents/);
  });
});

describe("durability is separate from winning the revision", () => {
  it("a commit is visible only once complete, so a partial write cannot block a revision", async () => {
    // The reason the commit is temp-then-link rather than a direct exclusive-create write: a crash
    // mid-write would leave a file that exists and cannot be parsed, blocking the true winner from
    // that revision forever.
    await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: 0,
      transitions: [reserved("a")],
    });

    const entries = await readdir(join(root, GRANT, "commits"));
    // No temp files left behind, and exactly one commit.
    expect(entries).toEqual(["000001.json"]);
  });

  it("refuses a stream with a gap rather than reducing a shorter history", async () => {
    await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: 0,
      transitions: [reserved("a")],
    });
    // A commit no correct writer could have produced: revision 3 with no revision 2.
    await writeFile(
      join(root, GRANT, "commits", "000003.json"),
      JSON.stringify({ revision: 3, transitions: [] }),
      "utf8",
    );

    // Understating committed authorization is the failure that matters, so this refuses rather
    // than projecting the first commit and reporting a larger balance.
    await expect(store.readGrant(GRANT)).rejects.toThrow(/missing revision 2/);
  });
});

describe("lookups scan, because a hint cannot establish absence", () => {
  it("finds a reservation in any grant without an index", async () => {
    await store.compareAndAppend({
      grantId: "grant-other",
      expectedRevision: 0,
      transitions: [reserved("a", { grantId: "grant-other" })],
    });

    const found = await store.get("res-a");

    expect(found?.reservationId).toBe("res-a");
    expect(found?.status).toBe("reserved");
  });

  it("returns undefined only after scanning", async () => {
    expect(await store.get("res-nowhere")).toBeUndefined();
  });

  it("lists a Run's reservations across grants", async () => {
    await store.compareAndAppend({
      grantId: GRANT,
      expectedRevision: 0,
      transitions: [reserved("a")],
    });
    await store.compareAndAppend({
      grantId: "grant-other",
      expectedRevision: 0,
      transitions: [reserved("b", { grantId: "grant-other" })],
    });

    expect((await store.listByRun("run-a")).map((r) => r.reservationId).sort()).toEqual([
      "res-a",
      "res-b",
    ]);
  });
});

describe("a reservation is findable through a grant whose id is not a plain word", () => {
  // Every test above uses `grant-a`. The first adopter's grants are named
  // `grant:<runId>:agent:<decisionId>` — the Run is inside the grant's own identity — and a grant
  // id becomes a directory name at `reservation-store.ts:249`. So the venue every existing test
  // measured in is one where the id happens to be a safe path segment, which is the property under
  // test rather than an incidental detail of the fixture.
  const NESTED = "grant:run_01AAAA:agent:dec_01BBBB";

  it("survives being a directory name, and the run is still found through it", async () => {
    await store.compareAndAppend({
      grantId: NESTED,
      expectedRevision: 0,
      transitions: [reserved("a", { grantId: NESTED } as never)],
    });

    const byRun = await store.listByRun("run-a");
    expect(byRun.map((r) => r.reservationId)).toContain("res-a");
  });

  it("stays found after a dispatch_prepared, which carries no runId of its own", async () => {
    // The adopter's exact shape: `reservation.reserved` carries `runId`, the transition after it
    // does not. If anything read the run off the latest transition rather than the projection, the
    // reservation would drop out of `listByRun` here and `costs settle` would answer
    // "holds no reservation" — the reported symptom.
    await store.compareAndAppend({
      grantId: NESTED,
      expectedRevision: 0,
      transitions: [reserved("a", { grantId: NESTED } as never)],
    });
    await store.compareAndAppend({
      grantId: NESTED,
      expectedRevision: 1,
      transitions: [
        {
          schemaVersion: SCHEMA_VERSION,
          transitionId: "a-prepared",
          reservationId: "res-a",
          grantId: NESTED,
          kind: "reservation.dispatch_prepared",
          at: "2026-01-01T00:00:01.000Z",
          detail: { execution: { attemptId: "att-1" } },
        } as unknown as SpendReservationTransition,
      ],
    });

    const byRun = await store.listByRun("run-a");
    const found = byRun.find((r) => r.reservationId === "res-a");
    expect(found).toBeDefined();
    expect(found?.runId).toBe("run-a");
    expect(found?.execution).toBeDefined();
  });
});

describe('a store that cannot look does not answer "nothing"', () => {
  // The first adopter held $12.00 in a reservation `costs` reported as an empty ledger and `settle`
  // refused as "Run holds no reservation". Their composition rooted the store at a path this one
  // does not read, and `#grantIds()` caught every error and returned `[]` — so a root it could not
  // read was indistinguishable from a root with nothing in it. Both statements were about the
  // world; neither instrument had reached the world.
  it("reports an empty store for a root that does not exist yet", async () => {
    // The legitimate empty answer, kept: a workspace that has reserved nothing has no root.
    const missing = new FileSpendReservationStore({ root: join(root, "never-created") });
    await expect(missing.listByRun("run-a")).resolves.toEqual([]);
  });

  it("throws for a root it cannot read, rather than reporting an empty store", async () => {
    // A file where the directory belongs — ENOTDIR, not ENOENT. Under the old catch-all this
    // returned `[]` and the caller stated "no reservations" as a fact.
    const asFile = join(root, "root-is-a-file");
    await writeFile(asFile, "not a directory", "utf8");
    const broken = new FileSpendReservationStore({ root: asFile });

    await expect(broken.listByRun("run-a")).rejects.toThrow();
  });

  it("names where it looked, so two compositions can compare paths", async () => {
    const store = new FileSpendReservationStore({ root: join(root, "spend", "reservations") });
    expect(store.root).toBe(join(root, "spend", "reservations"));
  });
});
