/**
 * Advisory locking (contract §19.1, ADR-0005).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { AldusError } from "@aldus/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileStoreErrorCodes } from "../src/errors.js";
import { FileLockManager } from "../src/lock.js";

import { makeTempWorkspace, type TempWorkspace } from "./helpers.js";

let workspace: TempWorkspace;
let lockDirectory: string;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
  lockDirectory = join(workspace.root, "locks");
  await mkdir(lockDirectory, { recursive: true });
});

afterEach(async () => {
  await workspace.cleanup();
});

/** A manager whose clock the test controls. */
function managerWithClock(start = 1_700_000_000_000) {
  let current = start;
  const manager = new FileLockManager(lockDirectory, {
    now: () => current,
    retryMs: 1,
  });
  return {
    manager,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("acquire and release", () => {
  it("acquires an uncontended lock and removes the lockfile on release", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    const lease = await manager.acquire("run-a");
    expect(await readFile(manager.pathFor("run-a"), "utf8")).toContain(lease.id);

    expect(await lease.release()).toBe(true);
    expect(await readFile(manager.pathFor("run-a"), "utf8").catch(() => undefined)).toBeUndefined();
  });

  it("reports release of a lease that was already lost", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    const lease = await manager.acquire("run-a");
    await lease.release();
    expect(await lease.release()).toBe(false);
  });

  it("serialises contending acquirers", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    const observed: string[] = [];
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        manager.withLock("run-a", async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          observed.push(`enter-${index}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          observed.push(`exit-${index}`);
          concurrent -= 1;
        }),
      ),
    );

    // The point of a lock: never two holders at once, and every body ran.
    expect(peak).toBe(1);
    expect(observed).toHaveLength(16);
  });

  it("locks distinct resources independently", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    const first = await manager.acquire("run-a");
    // A second resource must not be blocked by the first, or unrelated Runs would serialise.
    const second = await manager.acquire("run-b", { timeoutMs: 200 });
    expect(second.id).not.toBe(first.id);
    await first.release();
    await second.release();
  });

  it("times out against a live holder that keeps renewing", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    const held = await manager.acquire("run-a");
    try {
      await manager.acquire("run-a", { timeoutMs: 30 });
      expect.unreachable("expected a lock timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(AldusError);
      const aldusError = error as AldusError;
      expect(aldusError.code).toBe(FileStoreErrorCodes.LOCK_TIMEOUT);
      expect(aldusError.retryable).toBe(true);
      expect(aldusError.details).toMatchObject({ resource: "run-a" });
    } finally {
      await held.release();
    }
  });
});

describe("stale locks", () => {
  it("reclaims a lock whose TTL has expired", async () => {
    const { manager, advance } = managerWithClock();
    const abandoned = await manager.acquire("run-a", { ttlMs: 1_000 });

    advance(1_500);

    const reclaimed = await manager.acquire("run-a", { timeoutMs: 50 });
    expect(reclaimed.id).not.toBe(abandoned.id);
    // The original holder must discover it no longer holds the lock.
    expect(await abandoned.release()).toBe(false);
    await reclaimed.release();
  });

  it("does not reclaim a lock that is still within its TTL", async () => {
    const { manager, advance } = managerWithClock();
    const held = await manager.acquire("run-a", { ttlMs: 10_000 });
    advance(1_000);
    await expect(manager.acquire("run-a", { timeoutMs: 20 })).rejects.toThrow(AldusError);
    await held.release();
  });

  it("reclaims a lock held by a dead process on this host", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    const path = manager.pathFor("run-a");
    // PID 0x7FFFFFFF will not exist; the record is otherwise fresh, so only the liveness probe
    // can justify reclaiming it.
    await writeFile(
      path,
      JSON.stringify({
        lockId: "ghost",
        resource: "run-a",
        pid: 0x7fff_ffff,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        renewedAt: new Date().toISOString(),
        ttlMs: 600_000,
      }),
      "utf8",
    );

    const lease = await manager.acquire("run-a", { timeoutMs: 200 });
    expect(lease.id).not.toBe("ghost");
    await lease.release();
  });

  it("does not reclaim a fresh lock recorded by another host", async () => {
    // A PID from another machine says nothing about a process here, so the liveness probe must
    // not apply. Only the TTL may reclaim it.
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    await writeFile(
      manager.pathFor("run-a"),
      JSON.stringify({
        lockId: "remote",
        resource: "run-a",
        pid: 0x7fff_ffff,
        host: "some-other-host",
        acquiredAt: new Date().toISOString(),
        renewedAt: new Date().toISOString(),
        ttlMs: 600_000,
      }),
      "utf8",
    );
    await expect(manager.acquire("run-a", { timeoutMs: 20 })).rejects.toThrow(AldusError);
  });

  it("treats an unparseable lockfile as dead rather than wedging the workspace", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    await writeFile(manager.pathFor("run-a"), "{not json", "utf8");
    const lease = await manager.acquire("run-a", { timeoutMs: 200 });
    expect(lease.id).toBeTruthy();
    await lease.release();
  });

  it("renews a lease, pushing back its expiry", async () => {
    const { manager, advance } = managerWithClock();
    const lease = await manager.acquire("run-a", { ttlMs: 1_000 });
    advance(800);
    expect(await lease.renew()).toBe(true);
    advance(800);
    // Without the renewal this would now be stale; with it, a contender must still wait.
    await expect(manager.acquire("run-a", { timeoutMs: 20 })).rejects.toThrow(AldusError);
    await lease.release();
  });

  it("reports renewal of a lease that was already lost", async () => {
    const { manager, advance } = managerWithClock();
    const abandoned = await manager.acquire("run-a", { ttlMs: 1_000 });
    advance(1_500);
    const stolen = await manager.acquire("run-a", { timeoutMs: 50 });
    expect(await abandoned.renew()).toBe(false);
    await stolen.release();
  });
});

describe("withLock", () => {
  it("returns the body's value and releases", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    expect(await manager.withLock("run-a", async () => 42)).toBe(42);
    const next = await manager.acquire("run-a", { timeoutMs: 50 });
    await next.release();
  });

  it("propagates the body's error unchanged, without masking it", async () => {
    const manager = new FileLockManager(lockDirectory, { retryMs: 1 });
    await expect(
      manager.withLock("run-a", async () => {
        throw new Error("the body failed");
      }),
    ).rejects.toThrow("the body failed");
    // And the lock is still released, or the workspace would wedge on the first failure.
    const next = await manager.acquire("run-a", { timeoutMs: 50 });
    await next.release();
  });

  it("fails when the lease was lost while the body was still running", async () => {
    const { manager, advance } = managerWithClock();
    try {
      await manager.withLock(
        "run-a",
        async () => {
          // Simulate a stall long enough for a contender to reclaim the lock.
          advance(5_000);
          const thief = await manager.acquire("run-a", { timeoutMs: 50 });
          await thief.release();
          return "written without exclusivity";
        },
        { ttlMs: 1_000 },
      );
      expect.unreachable("expected the lost lease to be reported");
    } catch (error) {
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.LOCK_LOST);
    }
  });
});
