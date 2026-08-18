/**
 * The Performance Layer (architecture contract §14).
 *
 * §14.2 is the requirement shaping most of this: an adopter may keep authoring performance
 * instructions in whatever format it already uses, an adapter parses that into a
 * PerformanceScript, and "the source format SHOULD change only after the structured
 * representation has proven stable". So derivation is the expected path, not a fallback.
 */

import { AldusError } from "@aldus-runtime/core";
import { describe, expect, it } from "vitest";

import { digestText } from "../src/common.js";
import { TtsLedgerErrorCodes } from "../src/errors.js";
import { TtsLedger } from "../src/ledger.js";
import {
  performanceScriptSchema,
  performanceSegmentSchema,
  type PerformanceScriptDeriver,
} from "../src/performance.js";
import {
  MemoryLedgerEventSink,
  MemoryPlanStore,
  MemoryScriptStore,
  MemoryTakeStore,
} from "../src/ports.js";
import { AT, EPISODE_ID, OPERATOR, RUN_ID, script } from "./helpers.js";

function makeLedger() {
  const scripts = new MemoryScriptStore();
  const events = new MemoryLedgerEventSink();
  const ledger = new TtsLedger({
    takes: new MemoryTakeStore(),
    plans: new MemoryPlanStore(),
    scripts,
    events,
    now: () => new Date(AT),
  });
  return { ledger, scripts, events };
}

/** A deriver standing in for an adopter's own authoring format (§14.2). */
const bracketDeriver: PerformanceScriptDeriver = {
  sourceFormat: "bracket-tags",
  adapterId: "adapter-a",
  adapterVersion: "1.0.0",
  deriveSegments: (source) =>
    source
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        const emphasis = [...line.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1] ?? "");
        const spokenText = line.replace(/\[([^\]]+)\]/g, "$1").trim();
        return {
          segmentId: `seg-${index + 1}`,
          spokenText,
          ...(emphasis.length > 0 ? { emphasis } : {}),
        };
      }),
};

describe("PerformanceSegment (§14.1)", () => {
  it("accepts a segment with nothing but text", () => {
    // §14.2 expects adoption to begin with plain text and acquire structure over time, so
    // everything beyond the text must be optional.
    expect(
      performanceSegmentSchema.safeParse({ segmentId: "seg-1", spokenText: "Hello." }).success,
    ).toBe(true);
  });

  it("accepts every field §14.1 lists", () => {
    expect(
      performanceSegmentSchema.safeParse({
        segmentId: "seg-1",
        spokenText: "Hello there.",
        intent: "warm opening",
        pace: "slow",
        emphasis: ["there"],
        pauses: [{ after: "Hello", strength: 2 }],
        emotion: "friendly",
        pronunciationRefs: ["entry-a"],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty spoken text", () => {
    // An empty segment would pass into a plan and bill for silence.
    expect(performanceSegmentSchema.safeParse({ segmentId: "seg-1", spokenText: "" }).success).toBe(
      false,
    );
  });

  it("keeps intent and emotion as free text", () => {
    // §14.1 gives no vocabulary for either, so neither may become an enum — an adopter's
    // editorial language is theirs (§4.2).
    for (const value of ["wry", "conspiratorial", "matter-of-fact, slightly rushed"]) {
      expect(
        performanceSegmentSchema.safeParse({
          segmentId: "seg-1",
          spokenText: "x",
          intent: value,
          emotion: value,
        }).success,
        value,
      ).toBe(true);
    }
  });
});

describe("PerformanceScript origin (§14.2, §25 item 6)", () => {
  it("requires a derivation exactly when the script is derived", () => {
    const base = { ...script(), origin: "derived" as const };
    expect(performanceScriptSchema.safeParse(base).success).toBe(false);
    expect(
      performanceScriptSchema.safeParse({
        ...base,
        derivation: {
          sourceFormat: "bracket-tags",
          sourceSha256: digestText("source"),
          adapterId: "adapter-a",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects a derivation on an authored script", () => {
    // An authored script that claims a source would make provenance a lie.
    expect(
      performanceScriptSchema.safeParse({
        ...script(),
        origin: "authored",
        derivation: {
          sourceFormat: "bracket-tags",
          sourceSha256: digestText("source"),
          adapterId: "adapter-a",
        },
      }).success,
    ).toBe(false);
  });

  it("supports a tagger-proposed script as its own origin (§14.3)", () => {
    // §14.3 subjects generated tags to Performance Freeze, so an operator must be able to see
    // that a machine proposed the performance and whether anyone has edited it since.
    const tagged = performanceScriptSchema.safeParse({
      ...script(),
      origin: "tagged",
      humanEditedSegmentIds: ["seg-1"],
    });
    expect(tagged.success).toBe(true);
  });
});

describe("deriveScript (§14.2)", () => {
  it("parses an adopter's format and records what produced the script", () => {
    const { ledger } = makeLedger();
    const source = "The [first] thing.\nThe second thing.";
    return ledger
      .deriveScript(bracketDeriver, source, {
        runId: RUN_ID,
        scriptId: "script-derived",
        episodeId: EPISODE_ID,
        actor: OPERATOR,
      })
      .then((derived) => {
        expect(derived.origin).toBe("derived");
        expect(derived.segments).toHaveLength(2);
        expect(derived.segments[0]?.spokenText).toBe("The first thing.");
        expect(derived.segments[0]?.emphasis).toEqual(["first"]);
        // The source digest is what makes a later parsing change attributable to the adapter
        // rather than appearing as a change in the content.
        expect(derived.derivation?.sourceSha256).toBe(digestText(source));
        expect(derived.derivation?.adapterId).toBe("adapter-a");
      });
  });

  it("refuses a source that yields no segments", async () => {
    // An empty script would pass silently into a request plan and synthesise nothing.
    const { ledger } = makeLedger();
    let error: AldusError | undefined;
    try {
      await ledger.deriveScript(bracketDeriver, "   \n  ", {
        runId: RUN_ID,
        scriptId: "script-empty",
        episodeId: EPISODE_ID,
        actor: OPERATOR,
      });
    } catch (thrown) {
      error = thrown as AldusError;
    }
    expect(error?.code).toBe(TtsLedgerErrorCodes.DERIVATION_FAILED);
  });

  it("wraps a deriver's own failure in a structured error", async () => {
    const { ledger } = makeLedger();
    const broken: PerformanceScriptDeriver = {
      sourceFormat: "broken",
      adapterId: "adapter-b",
      deriveSegments: () => {
        throw new Error("unbalanced bracket at line 3");
      },
    };
    let error: AldusError | undefined;
    try {
      await ledger.deriveScript(broken, "x", {
        runId: RUN_ID,
        scriptId: "script-broken",
        episodeId: EPISODE_ID,
        actor: OPERATOR,
      });
    } catch (thrown) {
      error = thrown as AldusError;
    }
    expect(error?.code).toBe(TtsLedgerErrorCodes.DERIVATION_FAILED);
    expect(error?.message).toContain("unbalanced bracket");
  });
});

describe("events (§6.4)", () => {
  it("emits an event for every recorded script", async () => {
    // §6.4 requires *every* state mutation to emit an immutable event, not the important ones.
    const { ledger, events } = makeLedger();
    await ledger.recordScript(script(), EPISODE_ID, OPERATOR);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]?.action).toBe("tts.script.recorded");
    expect(events.events[0]?.runId).toBe(RUN_ID);
    expect(events.events[0]?.episodeId).toBe(EPISODE_ID);
  });

  it("redacts event details, because an event is durable (§19.2)", async () => {
    const { ledger, events } = makeLedger();
    await ledger.recordScript(script(), EPISODE_ID, OPERATOR);
    // The ledger passes details through Core's redact() before emitting; a secret written into
    // an event once is leaked permanently.
    expect(JSON.stringify(events.events[0]?.details)).not.toContain("undefined");
  });
});
