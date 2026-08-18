/**
 * Crash-safe file primitives.
 *
 * Architecture contract §19.1 requires "recovery from partial success" and "recovery from
 * interrupted writes" (§22 WP-02). The failure this module exists to prevent is concrete: an
 * operator's machine sleeps, a process is killed, or a container is evicted midway through
 * rewriting `run.json`, and the next read finds a half-written file where the Run's state used
 * to be. Contract §3.4 makes files authoritative, so a truncated manifest is not an
 * inconvenience — it is the loss of the only authoritative record.
 *
 * The durability sequence is write-to-temp, fsync the file, rename, fsync the directory. Each
 * step is load-bearing:
 *
 * - **Temp file in the same directory.** `rename` is only atomic within a filesystem. A temp
 *   file in `os.tmpdir()` may be on a different device, which silently degrades the rename into
 *   a copy — exactly the non-atomic write this is meant to avoid.
 * - **fsync the file** before renaming, or the rename can be durable while the contents are not,
 *   leaving a correctly named empty file after a power loss.
 * - **fsync the directory** after renaming, or the rename itself may not survive a crash.
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Injection point for the durability sequence, so tests can interrupt it at a chosen step. */
export interface AtomicWriteHooks {
  /** Invoked after the temp file is written and synced, before the rename. */
  beforeRename?: (temporaryPath: string) => void | Promise<void>;
}

/** Options for {@link writeFileAtomic}. */
export interface AtomicWriteOptions {
  /** Test seam; unused in production paths. */
  hooks?: AtomicWriteHooks;
}

let temporaryCounter = 0;

/**
 * Write `contents` to `path` so that a reader sees either the previous bytes or the new bytes,
 * never a mixture.
 *
 * Parent directories are created as needed. The temp file is removed if any step fails, so an
 * interrupted write leaves no debris for the next reader to mistake for real state.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  // Same directory, therefore same filesystem, therefore a genuinely atomic rename. The counter
  // plus pid keeps two writers in one process from colliding on the temp name.
  temporaryCounter += 1;
  const temporaryPath = join(
    directory,
    `.${basenameOf(path)}.${process.pid}.${temporaryCounter}.tmp`,
  );

  try {
    const handle = await open(temporaryPath, "w");
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await options.hooks?.beforeRename?.(temporaryPath);

    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Append a single line to a file, creating it if absent, and sync before returning.
 *
 * Used for the append-only event log (contract §6.4). `O_APPEND` makes each write land at the
 * current end of file even with concurrent writers, so an interleaved append can never overwrite
 * another writer's bytes — it can only ever be interleaved *between* lines, or torn at the tail
 * if the process dies mid-write. {@link readJsonLines} handles the torn tail.
 */
export async function appendLineSynced(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${line}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read a file, returning `undefined` rather than throwing when it does not exist. */
export async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** True if `error` is a Node `ENOENT`. */
export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** True if `error` is a Node `EEXIST`, i.e. an `O_EXCL` create lost the race. */
export function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/**
 * Create a file only if it does not already exist, returning `false` if it did.
 *
 * `O_CREAT | O_EXCL` is the primitive the lock is built on: the check and the create are one
 * syscall, so two processes racing cannot both believe they created it.
 */
export async function createExclusive(path: string, contents: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    );
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

/** Overwrite a file in place without the rename dance. Used for lock heartbeats only. */
export async function overwrite(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8");
}

/** Remove a file, tolerating its absence. */
export async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * fsync a directory so that a rename within it survives a crash.
 *
 * Not portable: some platforms refuse to open a directory for the purpose. A failure here means
 * the rename may not be durable across a power loss, which is strictly weaker than the
 * within-process atomicity the rename already guarantees — so it is tolerated rather than
 * escalated into a failed write.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort by design; see the doc comment.
  }
}

function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index === -1 ? path : path.slice(index + 1);
}
