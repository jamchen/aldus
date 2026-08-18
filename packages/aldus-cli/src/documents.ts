/**
 * Reading JSON documents named on the command line.
 *
 * Several of the composed operations take a whole document rather than a handful of scalars: a
 * `ReleaseBundle` (§17), a `PerformanceScript` (§14.1), a `TtsRequestPlan` (§15). Those are not
 * things to assemble from flags — a bundle carries operation lists with branded criticality, and
 * flattening it into `--operation-1-kind` would be a worse interface and a lossy one.
 *
 * So they arrive as files. The CLI reads and parses; **it does not validate the shape**, because
 * the schema belongs to the package that owns the type and the service already refuses what it
 * cannot use. A second opinion here would be a second place to disagree.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { AldusError } from "@aldus-runtime/core";

/**
 * Read and parse a JSON document named by a flag.
 *
 * @throws {AldusError} `ALDUS_DOCUMENT_UNREADABLE` if the file cannot be read, and
 * `ALDUS_DOCUMENT_MALFORMED` if it is not JSON. Both are invocation problems: exit code 2, not a
 * refusal, because retrying the same command unchanged cannot help.
 */
export async function readJsonDocument<T>(path: string, flag: string, cwd: string): Promise<T> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);

  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (cause) {
    throw new AldusError(
      "ALDUS_DOCUMENT_UNREADABLE",
      `Could not read ${flag} from "${path}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { category: "io", retryable: false, details: { flag, path } },
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new AldusError(
      "ALDUS_DOCUMENT_MALFORMED",
      `${flag} at "${path}" is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { category: "validation", retryable: false, details: { flag, path } },
    );
  }
}

/**
 * Require a string flag, naming what is missing rather than failing obscurely.
 *
 * @throws {AldusError} `ALDUS_INVALID_REQUEST`.
 */
export function requireFlag(
  values: Record<string, unknown>,
  flag: string,
  command: string,
  hint: string,
): string {
  const value = values[flag];
  if (typeof value === "string" && value.length > 0) return value;
  throw new AldusError("ALDUS_INVALID_REQUEST", `"${command}" needs --${flag} <${hint}>.`, {
    category: "validation",
    details: { command, flag },
  });
}
