/**
 * Append-only log recovery (contract §6.4, §19.1).
 *
 * The distinction under test is the one that matters: a torn tail is recovery, a corrupt interior
 * line is damage. Conflating them would turn "your audit log lost an event" into silence.
 */

import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AldusError } from "@aldus-runtime/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileStoreErrorCodes } from "../src/errors.js";
import { parseJsonLines, readJsonLines, toJsonLine } from "../src/jsonl.js";

import { makeTempWorkspace, type TempWorkspace } from "./helpers.js";

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

const wellFormed = '{"a":1}\n{"a":2}\n{"a":3}\n';

describe("parseJsonLines", () => {
  it("parses a well-formed log", () => {
    const result = parseJsonLines(wellFormed);
    expect(result.values).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(result.tornTail).toBeUndefined();
  });

  it("accepts a complete final line with no trailing newline", () => {
    // The append was interrupted after the JSON but before the newline. The record is complete.
    const result = parseJsonLines('{"a":1}\n{"a":2}');
    expect(result.values).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.tornTail).toBeUndefined();
  });

  it("recovers from a torn final line, keeping everything before it", () => {
    const result = parseJsonLines('{"a":1}\n{"a":2}\n{"a":3');
    expect(result.values).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.tornTail).toBe('{"a":3');
  });

  it("fails on a torn final line when the caller asked for strict reads", () => {
    try {
      parseJsonLines('{"a":1}\n{"a":2', { strictTail: true });
      expect.unreachable("expected a torn-tail error");
    } catch (error) {
      expect(error).toBeInstanceOf(AldusError);
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.EVENT_LOG_TORN_TAIL);
    }
  });

  // An append-only file can only ever be damaged at its tail. Anything else means bytes inside
  // the log were lost or overwritten, and calling that "recovery" would silently drop an event.
  it("refuses a corrupt interior line", () => {
    try {
      parseJsonLines('{"a":1}\n{"a":BROKEN}\n{"a":3}\n');
      expect.unreachable("expected a corruption error");
    } catch (error) {
      expect(error).toBeInstanceOf(AldusError);
      const aldusError = error as AldusError;
      expect(aldusError.code).toBe(FileStoreErrorCodes.EVENT_LOG_CORRUPT);
      expect(aldusError.details).toMatchObject({ line: 2 });
    }
  });

  it("refuses an unparseable final line when the file ends with a newline", () => {
    // A trailing newline proves the write completed, so a bad line before it is damage, not a
    // torn append.
    try {
      parseJsonLines('{"a":1}\n{"a":BROKEN}\n');
      expect.unreachable("expected a corruption error");
    } catch (error) {
      expect((error as AldusError).code).toBe(FileStoreErrorCodes.EVENT_LOG_CORRUPT);
    }
  });

  it("never puts a log line's contents into the error", () => {
    // An event may carry redacted-but-sensitive context (§19.2), and an error is itself durable.
    const secretish = '{"token":"SHOULD-NOT-APPEAR-IN-ERROR"';
    try {
      parseJsonLines(`{"a":1}\n${secretish}\n{"a":3}\n`);
      expect.unreachable("expected a corruption error");
    } catch (error) {
      expect(JSON.stringify((error as AldusError).toStructuredError())).not.toContain(
        "SHOULD-NOT-APPEAR-IN-ERROR",
      );
    }
  });

  it("skips blank lines and reports where they were", () => {
    const result = parseJsonLines('{"a":1}\n\n{"a":2}\n');
    expect(result.values).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.blankLines).toEqual([2]);
  });

  it("treats an empty file as an empty log", () => {
    expect(parseJsonLines("")).toEqual({ values: [], blankLines: [] });
  });
});

describe("readJsonLines", () => {
  it("treats a missing file as an empty log", async () => {
    const result = await readJsonLines(join(workspace.root, "events.jsonl"));
    expect(result.values).toEqual([]);
  });

  // The real thing: write a valid log, then truncate it mid-line as a killed process would.
  it("recovers a log truncated mid-line on disk", async () => {
    const path = join(workspace.root, "events.jsonl");
    await writeFile(path, wellFormed, "utf8");
    await truncate(path, wellFormed.length - 4);

    const result = await readJsonLines(path);
    expect(result.values).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.tornTail).toBe('{"a"');
  });

  it("names the file in a corruption error", async () => {
    const path = join(workspace.root, "events.jsonl");
    await writeFile(path, '{"a":1}\nnot json\n{"a":3}\n', "utf8");
    try {
      await readJsonLines(path);
      expect.unreachable("expected a corruption error");
    } catch (error) {
      expect((error as AldusError).details).toMatchObject({ path, line: 2 });
    }
  });
});

describe("toJsonLine", () => {
  it("escapes newlines so one value is always exactly one line", () => {
    const line = toJsonLine({ note: "first\nsecond" });
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ note: "first\nsecond" });
  });
});
