/**
 * Append-only JSON Lines reading.
 *
 * Architecture contract §6.4 requires every state mutation to emit an immutable event, and §7
 * stores those events in `events.jsonl`. §19.1 requires "recovery from partial success".
 *
 * The distinction this module draws is the whole point of it:
 *
 * - A **torn tail** is the last line of the file being incomplete. That is what a process killed
 *   mid-append leaves behind, it is expected, and everything before it is intact. Discarding it
 *   with a report is recovery.
 * - A **corrupt interior line** is an unparseable line with complete lines after it. That cannot
 *   result from an interrupted append, because appends only ever extend the file. It means bytes
 *   inside an append-only log were lost or overwritten, and reporting it as a recoverable
 *   truncation would be a lie that silently drops an audit record.
 *
 * Treating the second case as the first is the failure mode worth engineering against: it would
 * turn "your audit log is damaged" into "everything is fine, minus one event you will never
 * learn about".
 */

import { readFileOrUndefined } from "./atomic.js";
import { FileStoreErrorCodes, fileStoreError } from "./errors.js";

/** What a JSON Lines read found. */
export interface JsonLinesReadResult {
  /** Successfully parsed values, in file order. */
  values: unknown[];
  /**
   * The raw text of a truncated final line, when one was found.
   *
   * Surfaced rather than swallowed so a caller can log it, and so a test can assert recovery
   * happened rather than assert that nothing went wrong.
   */
  tornTail?: string;
  /** 1-based line numbers that were blank and therefore carried no record. */
  blankLines: number[];
}

/** Options for {@link readJsonLines}. */
export interface ReadJsonLinesOptions {
  /**
   * Fail on a torn tail instead of recovering from it.
   *
   * Default `false`. A reader inspecting state wants recovery; a tool auditing log integrity
   * wants to know. Both are legitimate, so it is the caller's choice rather than a policy baked
   * into the reader.
   */
  strictTail?: boolean;
  /** Included in error details so a failure names the file it came from. */
  path?: string;
}

/**
 * Parse a JSON Lines file.
 *
 * Returns an empty result when the file does not exist: a Run with no events yet is an ordinary
 * state, not an error.
 *
 * @throws {AldusError} `ALDUS_EVENT_LOG_CORRUPT` when an interior line cannot be parsed, or
 * `ALDUS_EVENT_LOG_TORN_TAIL` when the tail is torn and `strictTail` is set.
 */
export async function readJsonLines(
  path: string,
  options: ReadJsonLinesOptions = {},
): Promise<JsonLinesReadResult> {
  const contents = await readFileOrUndefined(path);
  if (contents === undefined || contents.length === 0) {
    return { values: [], blankLines: [] };
  }
  return parseJsonLines(contents, { ...options, path: options.path ?? path });
}

/** Parse JSON Lines text. Separated from IO so the recovery rules can be tested directly. */
export function parseJsonLines(
  contents: string,
  options: ReadJsonLinesOptions = {},
): JsonLinesReadResult {
  // An empty file is an empty log, not a blank line: `"".split("\n")` yields `[""]`, which would
  // otherwise be reported as a blank line that was never written.
  if (contents.length === 0) return { values: [], blankLines: [] };

  const endsWithNewline = contents.endsWith("\n");
  const rawLines = contents.split("\n");
  // A well-formed file ends with a newline, which `split` renders as a trailing empty element.
  // Dropping it is what makes "the last element" mean "the possibly-torn line".
  if (endsWithNewline) rawLines.pop();

  const values: unknown[] = [];
  const blankLines: number[] = [];
  let tornTail: string | undefined;

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] ?? "";
    const isLastLine = index === rawLines.length - 1;

    // A blank line carries no record and cannot represent a lost event, so it is skipped rather
    // than treated as corruption — but it is reported, so nothing is silently ignored.
    if (line.trim().length === 0) {
      blankLines.push(index + 1);
      continue;
    }

    try {
      values.push(JSON.parse(line));
    } catch {
      // Only the final line of a file with no trailing newline can be a torn append. Anything
      // else is damage inside an append-only file.
      if (isLastLine && !endsWithNewline) {
        if (options.strictTail === true) {
          throw fileStoreError(
            FileStoreErrorCodes.EVENT_LOG_TORN_TAIL,
            "The final line of the event log is truncated, which is what an interrupted append " +
              "leaves behind. Every line before it is intact.",
            {
              category: "io",
              retryable: false,
              details: { path: options.path, line: index + 1, byteLength: line.length },
            },
          );
        }
        tornTail = line;
        continue;
      }

      throw fileStoreError(
        FileStoreErrorCodes.EVENT_LOG_CORRUPT,
        "An event log line could not be parsed, and it is not the final line. An append-only " +
          "log can only ever be damaged at its tail, so this means bytes inside the log were " +
          "lost or overwritten.",
        {
          category: "io",
          retryable: false,
          // The line's contents are deliberately excluded: an event may carry redacted-but-
          // sensitive context (§19.2), and an error is itself a durable record.
          details: { path: options.path, line: index + 1, byteLength: line.length },
        },
      );
    }
  }

  return tornTail === undefined ? { values, blankLines } : { values, blankLines, tornTail };
}

/** Serialise a value to a single JSON Lines entry. Rejects embedded newlines by construction. */
export function toJsonLine(value: unknown): string {
  // `JSON.stringify` escapes newlines inside strings, so one value is always exactly one line.
  return JSON.stringify(value);
}
