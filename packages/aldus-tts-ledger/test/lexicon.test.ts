/**
 * The TTS lexicon (architecture contract §15.2, §9.2).
 *
 * The requirement doing the work here is §9.2's, which §15.2 inherits by being pack content:
 * "Conflicts MUST be detectable. Silent last-write-wins behavior SHOULD be avoided for normative
 * rules." An operator who has written two contradictory pronunciation rules needs to be told, not
 * to have one silently chosen and baked into paid audio.
 */

import { AldusError } from "@aldus/core";
import { describe, expect, it } from "vitest";

import { TtsLedgerErrorCodes } from "../src/errors.js";
import {
  requireLexicon,
  resolveLexicon,
  scopeMatches,
  specificityOf,
  type LexiconEntry,
} from "../src/lexicon.js";

function entry(overrides: Partial<LexiconEntry> = {}): LexiconEntry {
  return {
    schemaVersion: "1.2",
    entryId: "entry-a",
    written: "Aldus",
    spoken: "AL-dus",
    authority: "normative",
    approvalStatus: "approved",
    version: "1",
    ...overrides,
  };
}

describe("scope matching (§15.2)", () => {
  it("applies an unscoped entry everywhere", () => {
    // A global rule is global. An entry declaring nothing must not be filtered out by a context
    // it says nothing about.
    expect(scopeMatches(entry(), { show: "example-show", voice: "voice-a" })).toBe(true);
  });

  it("applies an entry only where every dimension it declares matches", () => {
    const scoped = entry({ scope: { show: "example-show", voice: "voice-a" } });
    expect(scopeMatches(scoped, { show: "example-show", voice: "voice-a" })).toBe(true);
    expect(scopeMatches(scoped, { show: "example-show", voice: "voice-b" })).toBe(false);
    expect(scopeMatches(scoped, { show: "example-show" })).toBe(false);
  });

  it("ignores context dimensions the entry says nothing about", () => {
    const scoped = entry({ scope: { show: "example-show" } });
    expect(scopeMatches(scoped, { show: "example-show", scriptForm: "narration" })).toBe(true);
  });

  it("accepts a scope dimension nothing in the runtime has ever heard of", () => {
    // Proof no enum crept in. §15.2 names seven dimensions and §4.2 forbids naming three of them,
    // so an adopter must be able to add its own without forking.
    const exotic = entry({ scope: { deliveryContext: "live-read" } });
    expect(scopeMatches(exotic, { deliveryContext: "live-read" })).toBe(true);
    expect(specificityOf(exotic)).toBe(1);
  });
});

describe("resolution (§15.2, §9.2)", () => {
  it("prefers the more specific entry among equals", () => {
    const global = entry({ entryId: "global" });
    const scoped = entry({ entryId: "scoped", scope: { voice: "voice-a" }, spoken: "AWL-dus" });
    const resolution = resolveLexicon([global, scoped], { voice: "voice-a" });
    expect(resolution.winners.get("Aldus")?.entryId).toBe("scoped");
    expect(resolution.conflicts).toEqual([]);
  });

  it("lets authority outrank specificity", () => {
    // An `example` entry scoped to one episode must not override a `normative` global rule
    // merely by being more specific, or an illustration becomes more binding than a rule.
    // The same ordering ADR-0006 settled for Knowledge Packs.
    const rule = entry({ entryId: "rule", authority: "normative" });
    const illustration = entry({
      entryId: "illustration",
      authority: "example",
      scope: { episode: "episode-a" },
      spoken: "wrong",
    });
    const resolution = resolveLexicon([rule, illustration], { episode: "episode-a" });
    expect(resolution.winners.get("Aldus")?.entryId).toBe("rule");
  });

  it("reports a tie between normative entries instead of picking one", () => {
    const first = entry({ entryId: "first", scope: { voice: "voice-a" }, spoken: "AL-dus" });
    const second = entry({ entryId: "second", scope: { show: "example-show" }, spoken: "AWL-dus" });
    const resolution = resolveLexicon([first, second], {
      voice: "voice-a",
      show: "example-show",
    });
    expect(resolution.conflicts).toHaveLength(1);
    expect(resolution.conflicts[0]?.entries.map((candidate) => candidate.entryId).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(resolution.conflicts[0]?.explanation).toContain("§9.2");
  });

  it("does not report a normative entry beating an advisory one", () => {
    // A normal resolution. Reporting it would turn the conflict list into noise an operator
    // learns to ignore, which is how a real conflict then gets missed.
    const rule = entry({ entryId: "rule", authority: "normative" });
    const hint = entry({ entryId: "hint", authority: "advisory", spoken: "other" });
    const resolution = resolveLexicon([rule, hint], {});
    expect(resolution.conflicts).toEqual([]);
    expect(resolution.winners.get("Aldus")?.entryId).toBe("rule");
  });

  it("does not report tied advisory entries", () => {
    // §9.2 scopes its requirement to normative rules.
    const first = entry({ entryId: "a", authority: "advisory" });
    const second = entry({ entryId: "b", authority: "advisory", spoken: "other" });
    expect(resolveLexicon([first, second], {}).conflicts).toEqual([]);
  });

  it("excludes deprecated and retired entries but keeps them discoverable", () => {
    // §9.3 wants superseded guidance discoverable, which is not the same as letting it apply.
    const live = entry({ entryId: "live" });
    const old = entry({ entryId: "old", authority: "deprecated", spoken: "obsolete" });
    const retired = entry({ entryId: "retired", approvalStatus: "retired", spoken: "gone" });
    const resolution = resolveLexicon([live, old, retired], {});
    expect(resolution.winners.get("Aldus")?.entryId).toBe("live");
    expect(resolution.excluded.map((candidate) => candidate.entryId).sort()).toEqual([
      "old",
      "retired",
    ]);
  });

  it("reports entries filtered out by scope, so a missing rule is explicable", () => {
    const scoped = entry({ entryId: "scoped", scope: { voice: "voice-b" } });
    const resolution = resolveLexicon([scoped], { voice: "voice-a" });
    expect(resolution.winners.size).toBe(0);
    expect(resolution.outOfScope.map((candidate) => candidate.entryId)).toEqual(["scoped"]);
  });

  it("resolves independently per written form", () => {
    const first = entry({ entryId: "a", written: "Aldus" });
    const second = entry({ entryId: "b", written: "Manutius", spoken: "ma-NOO-shus" });
    const resolution = resolveLexicon([first, second], {});
    expect([...resolution.winners.keys()].sort()).toEqual(["Aldus", "Manutius"]);
  });
});

describe("requireLexicon", () => {
  it("returns the winners when nothing conflicts", () => {
    expect(requireLexicon([entry()], {}).get("Aldus")?.spoken).toBe("AL-dus");
  });

  it("refuses when normative rules contradict, rather than substituting one", () => {
    // The throwing form is for a caller about to *act*: substituting text under an unresolved
    // contradiction would bake one arbitrary reading into paid audio.
    const first = entry({ entryId: "first", scope: { voice: "voice-a" } });
    const second = entry({ entryId: "second", scope: { show: "example-show" }, spoken: "other" });
    let error: AldusError | undefined;
    try {
      requireLexicon([first, second], { voice: "voice-a", show: "example-show" });
    } catch (thrown) {
      error = thrown as AldusError;
    }
    expect(error?.code).toBe(TtsLedgerErrorCodes.LEXICON_CONFLICT);
    expect(error?.retryable).toBe(false);
  });
});
