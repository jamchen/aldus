import { describe, expect, it } from "vitest";

import {
  deriveScopeSelectors,
  observedDimensions,
  scopeKey,
  scopeLabel,
  scopeMatches,
  WHOLE_CORPUS_SLICE,
} from "../src/scope.js";

describe("scope keys", () => {
  it("names the whole-corpus slice explicitly", () => {
    expect(scopeKey(WHOLE_CORPUS_SLICE)).toBe("*");
    expect(scopeLabel(WHOLE_CORPUS_SLICE)).toBe("whole corpus");
  });

  // Sorting matters: an unsorted key would make {host,voice} and {voice,host} two slices of the
  // same cases, and each would carry half the evidence.
  it("produces one key regardless of dimension order", () => {
    const a = scopeKey({ dimensions: ["host", "voice"], values: { host: "h", voice: "v" } });
    const b = scopeKey({ dimensions: ["voice", "host"], values: { voice: "v", host: "h" } });
    expect(a).toBe(b);
  });
});

describe("matching", () => {
  it("matches when every held dimension agrees", () => {
    expect(
      scopeMatches(
        { host: "example-host", voice: "voice-a" },
        { dimensions: ["host"], values: { host: "example-host" } },
      ),
    ).toBe(true);
  });

  it("does not match when a held dimension differs", () => {
    expect(
      scopeMatches(
        { host: "other-host" },
        { dimensions: ["host"], values: { host: "example-host" } },
      ),
    ).toBe(false);
  });

  it("matches everything for the whole-corpus slice", () => {
    expect(scopeMatches({ anything: "at-all" }, WHOLE_CORPUS_SLICE)).toBe(true);
  });
});

describe("deriving selectors", () => {
  const scopes = [
    { host: "example-host", voice: "voice-a" },
    { host: "example-host", voice: "voice-b" },
    { host: "other-host", voice: "voice-a" },
  ];

  it("observes every dimension present", () => {
    expect(observedDimensions(scopes)).toEqual(["host", "voice"]);
  });

  // The default is each dimension alone, not the cross-product: with several dimensions a corpus
  // would shatter into slices of one or two cases, and a metric over two cases is noise that
  // reads like evidence.
  it("defaults to one slice per dimension value, not the cross product", () => {
    const selectors = deriveScopeSelectors(scopes);
    expect(selectors.map(scopeKey).sort()).toEqual([
      "host=example-host",
      "host=other-host",
      "voice=voice-a",
      "voice=voice-b",
    ]);
  });

  it("produces joint slices only when a grouping asks for them", () => {
    const selectors = deriveScopeSelectors(scopes, [["host", "voice"]]);
    expect(selectors.map(scopeKey).sort()).toEqual([
      "host=example-host & voice=voice-a",
      "host=example-host & voice=voice-b",
      "host=other-host & voice=voice-a",
    ]);
  });

  // Substituting a placeholder would invent a scope the labeller never asserted, and the case
  // would then be counted as evidence about a dimension nobody recorded for it.
  it("omits a case from a grouping it does not declare every dimension of", () => {
    const selectors = deriveScopeSelectors([{ host: "example-host" }], [["host", "voice"]]);
    expect(selectors).toEqual([]);
  });

  it("returns nothing when no case declares any scope", () => {
    expect(deriveScopeSelectors([{}, {}])).toEqual([]);
  });

  // §9.2's ladder is data and §12.1's dimension list is illustrative; a dimension this package
  // has never heard of must slice like any other.
  it("slices by a dimension nobody anticipated", () => {
    const selectors = deriveScopeSelectors([{ recordingRoom: "room-a" }]);
    expect(selectors.map(scopeKey)).toEqual(["recordingRoom=room-a"]);
  });
});
