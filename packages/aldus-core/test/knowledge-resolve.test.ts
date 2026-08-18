/**
 * Scope, precedence, conflict detection, and Run snapshots (architecture contract §9.2, §9.3,
 * §6.2).
 *
 * The assertions that matter most here are the §9.2 ones: a normative tie must be *reported*,
 * and a normative pack beating an advisory one must not be. Getting either wrong turns a
 * governance mechanism into noise or into silence.
 */

import { describe, expect, it } from "vitest";

import { KnowledgeErrorCodes } from "../src/knowledge/errors.js";
import type { KnowledgePackManifest } from "../src/knowledge/manifest.js";
import {
  DEFAULT_PRECEDENCE_LADDER,
  effectivePrecedence,
  placeOnLadder,
  PRECEDENCE_TIER_STRIDE,
  type PrecedenceTier,
} from "../src/knowledge/precedence.js";
import {
  isResolutionClean,
  resolveKnowledgePacks,
  toKnowledgePackRefs,
} from "../src/knowledge/resolve.js";
import { SCHEMA_VERSION } from "../src/schema-version.js";
import { validate } from "../src/validate.js";

function pack(
  overrides: Partial<KnowledgePackManifest> & { packId: string },
): KnowledgePackManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: "1",
    authority: "normative",
    ...overrides,
  };
}

const claim = (resolution: ReturnType<typeof resolveKnowledgePacks>, key: string) =>
  resolution.claims.find((entry) => entry.key === key);

describe("placeOnLadder (contract §9.2)", () => {
  it("places a pack with no scope at the global tier", () => {
    expect(placeOnLadder(pack({ packId: "a" })).tierName).toBe("global");
  });

  it.each([
    ["show", { show: "example-show" }, "show"],
    ["host", { host: "example-host" }, "host"],
    ["provider", { provider: "provider-a" }, "variant"],
    ["voice", { voice: "voice-a" }, "variant"],
    ["script form", { scriptForm: "narration" }, "variant"],
    ["language", { language: "en" }, "variant"],
    ["episode", { episode: "episode-a" }, "episode"],
  ])("places a %s-scoped pack in the %s tier", (_label, scope, tierName) => {
    expect(placeOnLadder(pack({ packId: "a", scope })).tierName).toBe(tierName);
  });

  it("uses the most specific dimension when several are declared", () => {
    const scoped = pack({
      packId: "a",
      scope: { show: "example-show", host: "example-host", episode: "episode-a" },
    });
    expect(placeOnLadder(scoped).tierName).toBe("episode");
  });

  // §4.2: the ladder is data, not an enumeration Core owns. An unrecognised dimension must not
  // silently reorder precedence, so it is reported rather than guessed at.
  it("reports an unrecognised dimension instead of guessing its tier", () => {
    const placement = placeOnLadder(pack({ packId: "a", scope: { someFutureAxis: "value-a" } }));
    expect(placement.tierName).toBe("global");
    expect(placement.unknownDimensions).toEqual(["someFutureAxis"]);
  });

  it("honours a caller-supplied ladder", () => {
    const ladder: PrecedenceTier[] = [
      { name: "global", dimensions: [] },
      { name: "tenant", dimensions: ["tenant"] },
      { name: "workspace", dimensions: ["workspace"] },
    ];
    const placement = placeOnLadder(pack({ packId: "a", scope: { workspace: "w1" } }), ladder);
    expect(placement.tierName).toBe("workspace");
    expect(placement.unknownDimensions).toEqual([]);
  });
});

describe("effectivePrecedence (contract §9.2)", () => {
  it("derives precedence from the tier", () => {
    expect(effectivePrecedence(pack({ packId: "a" }))).toBe(0);
    expect(effectivePrecedence(pack({ packId: "a", scope: { show: "s" } }))).toBe(
      PRECEDENCE_TIER_STRIDE,
    );
    expect(effectivePrecedence(pack({ packId: "a", scope: { episode: "e" } }))).toBe(
      4 * PRECEDENCE_TIER_STRIDE,
    );
  });

  it("lets an explicit precedence override the derived value", () => {
    expect(effectivePrecedence(pack({ packId: "a", precedence: 42 }))).toBe(42);
  });

  it("leaves room between tiers for explicit values to interleave", () => {
    expect(PRECEDENCE_TIER_STRIDE).toBeGreaterThan(1);
    expect(DEFAULT_PRECEDENCE_LADDER).toHaveLength(5);
  });
});

describe("applicability (contract §9.2)", () => {
  it("applies a global pack in every context", () => {
    const resolution = resolveKnowledgePacks([pack({ packId: "a" })], { context: {} });
    expect(resolution.applicable).toHaveLength(1);
  });

  it("applies a scoped pack only when the context matches", () => {
    const packs = [pack({ packId: "a", scope: { show: "example-show" } })];
    expect(
      resolveKnowledgePacks(packs, { context: { show: "example-show" } }).applicable,
    ).toHaveLength(1);
    expect(resolveKnowledgePacks(packs, { context: { show: "other-show" } }).applicable).toEqual(
      [],
    );
    expect(resolveKnowledgePacks(packs, { context: {} }).applicable).toEqual([]);
  });

  it("requires every declared dimension to match", () => {
    const packs = [pack({ packId: "a", scope: { show: "example-show", host: "example-host" } })];
    expect(
      resolveKnowledgePacks(packs, { context: { show: "example-show" } }).applicable,
    ).toHaveLength(0);
    expect(
      resolveKnowledgePacks(packs, {
        context: { show: "example-show", host: "example-host" },
      }).applicable,
    ).toHaveLength(1);
  });

  // Proves no enum crept into scope handling.
  it("resolves a dimension the loader has never seen", () => {
    const packs = [
      pack({ packId: "a", provides: ["k"], scope: { neverSeenBefore: "value-a" } }),
      pack({ packId: "b", provides: ["k"], authority: "advisory" }),
    ];
    const resolution = resolveKnowledgePacks(packs, { context: { neverSeenBefore: "value-a" } });
    expect(resolution.applicable.map((entry) => entry.manifest.packId).sort()).toEqual(["a", "b"]);
    expect(resolution.unknownDimensions).toEqual(["neverSeenBefore"]);
    expect(claim(resolution, "k")?.packId).toBe("a");
  });
});

describe("precedence resolution across the §9.2 chain", () => {
  const key = "editorial.tone";
  const tiers = [
    pack({ packId: "global-pack", provides: [key] }),
    pack({ packId: "show-pack", provides: [key], scope: { show: "example-show" } }),
    pack({ packId: "host-pack", provides: [key], scope: { host: "example-host" } }),
    pack({ packId: "variant-pack", provides: [key], scope: { voice: "voice-a" } }),
    pack({ packId: "episode-pack", provides: [key], scope: { episode: "episode-a" } }),
  ];
  const fullContext = {
    show: "example-show",
    host: "example-host",
    voice: "voice-a",
    episode: "episode-a",
  };

  it("gives the episode override the key when all five tiers apply", () => {
    const resolution = resolveKnowledgePacks(tiers, { context: fullContext });
    expect(claim(resolution, key)?.packId).toBe("episode-pack");
    expect(claim(resolution, key)?.overridden).toEqual([
      "variant-pack",
      "host-pack",
      "show-pack",
      "global-pack",
    ]);
  });

  it("falls back down the chain as context narrows", () => {
    const withoutEpisode = { show: "example-show", host: "example-host", voice: "voice-a" };
    expect(claim(resolveKnowledgePacks(tiers, { context: withoutEpisode }), key)?.packId).toBe(
      "variant-pack",
    );
    expect(
      claim(resolveKnowledgePacks(tiers, { context: { show: "example-show" } }), key)?.packId,
    ).toBe("show-pack");
    expect(claim(resolveKnowledgePacks(tiers, { context: {} }), key)?.packId).toBe("global-pack");
  });

  it("reports no conflict when the chain resolves cleanly", () => {
    expect(resolveKnowledgePacks(tiers, { context: fullContext }).conflicts).toEqual([]);
  });
});

describe("conflict detection (contract §9.2)", () => {
  it("reports two normative packs tied at the same precedence", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "editorial-a", provides: ["editorial.tone"] }),
      pack({ packId: "editorial-b", provides: ["editorial.tone"] }),
    ]);
    expect(resolution.conflicts).toHaveLength(1);
    const conflict = resolution.conflicts[0];
    expect(conflict?.code).toBe(KnowledgeErrorCodes.PACK_CONFLICT);
    expect(conflict?.key).toBe("editorial.tone");
    expect(conflict?.packIds).toEqual(["editorial-a", "editorial-b"]);
    expect(isResolutionClean(resolution)).toBe(false);
  });

  // The other half of §9.2, and the easier one to get wrong: a normal override must NOT be
  // reported, or the conflict report becomes noise an operator learns to ignore.
  it("does not report a normative pack beating an advisory one", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "normative-pack", provides: ["editorial.tone"] }),
      pack({ packId: "advisory-pack", provides: ["editorial.tone"], authority: "advisory" }),
    ]);
    expect(resolution.conflicts).toEqual([]);
    expect(claim(resolution, "editorial.tone")?.packId).toBe("normative-pack");
    expect(isResolutionClean(resolution)).toBe(true);
  });

  it("does not report a normative pack beating another at lower precedence", () => {
    const resolution = resolveKnowledgePacks(
      [
        pack({ packId: "global-pack", provides: ["editorial.tone"] }),
        pack({
          packId: "show-pack",
          provides: ["editorial.tone"],
          scope: { show: "example-show" },
        }),
      ],
      { context: { show: "example-show" } },
    );
    expect(resolution.conflicts).toEqual([]);
    expect(claim(resolution, "editorial.tone")?.packId).toBe("show-pack");
  });

  // A tie below an outright winner is resolved unambiguously; only the top matters.
  it("does not report a normative tie beneath a clear winner", () => {
    const resolution = resolveKnowledgePacks(
      [
        pack({
          packId: "episode-pack",
          provides: ["editorial.tone"],
          scope: { episode: "episode-a" },
        }),
        pack({ packId: "tied-a", provides: ["editorial.tone"] }),
        pack({ packId: "tied-b", provides: ["editorial.tone"] }),
      ],
      { context: { episode: "episode-a" } },
    );
    expect(resolution.conflicts).toEqual([]);
    expect(claim(resolution, "editorial.tone")?.packId).toBe("episode-pack");
  });

  it("does not report tied advisory packs", () => {
    // §9.2 asks for last-write-wins to be avoided "for normative rules". Advisory guidance is
    // not binding, so a tie there is not an operator-blocking condition.
    const resolution = resolveKnowledgePacks([
      pack({ packId: "advisory-a", provides: ["hint"], authority: "advisory" }),
      pack({ packId: "advisory-b", provides: ["hint"], authority: "advisory" }),
    ]);
    expect(resolution.conflicts).toEqual([]);
  });

  it("keeps packs claiming different keys independent", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "a", provides: ["key.one"] }),
      pack({ packId: "b", provides: ["key.two"] }),
    ]);
    expect(resolution.conflicts).toEqual([]);
    expect(resolution.claims).toHaveLength(2);
  });

  it("reports each contested key separately", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "a", provides: ["key.one", "key.two"] }),
      pack({ packId: "b", provides: ["key.one", "key.two"] }),
    ]);
    expect(resolution.conflicts.map((entry) => entry.key)).toEqual(["key.one", "key.two"]);
  });

  // Authority outranks precedence: "authority" means how binding content is, so an illustrative
  // pack must not override a binding rule merely by sitting on a more specific rung (ADR-0006).
  it("does not let an example pack outrank a normative one by precedence", () => {
    const resolution = resolveKnowledgePacks(
      [
        pack({ packId: "normative-global", provides: ["editorial.tone"] }),
        pack({
          packId: "example-episode",
          provides: ["editorial.tone"],
          authority: "example",
          scope: { episode: "episode-a" },
        }),
      ],
      { context: { episode: "episode-a" } },
    );
    expect(claim(resolution, "editorial.tone")?.packId).toBe("normative-global");
  });
});

describe("deprecated packs (contract §9.1, §9.3)", () => {
  const packs = [
    pack({ packId: "current-pack", provides: ["editorial.tone"] }),
    pack({
      packId: "retired-pack",
      provides: ["editorial.tone"],
      authority: "deprecated",
      scope: { episode: "episode-a" },
      negativeKnowledge: ["why-this-failed.md"],
    }),
  ];

  it("never lets a deprecated pack hold a claim, even at higher precedence", () => {
    const resolution = resolveKnowledgePacks(packs, { context: { episode: "episode-a" } });
    expect(claim(resolution, "editorial.tone")?.packId).toBe("current-pack");
  });

  it("keeps a deprecated pack discoverable", () => {
    // §9.3: negative knowledge is first-class content. Excluding a superseded pack from
    // resolution must not mean erasing it from the report.
    const resolution = resolveKnowledgePacks(packs, { context: { episode: "episode-a" } });
    expect(resolution.packs.map((entry) => entry.manifest.packId)).toContain("retired-pack");
    expect(resolution.applicable.map((entry) => entry.manifest.packId)).not.toContain(
      "retired-pack",
    );
  });

  it("excludes a deprecated pack from conflicts", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "current-pack", provides: ["k"] }),
      pack({ packId: "retired-pack", provides: ["k"], authority: "deprecated" }),
    ]);
    expect(resolution.conflicts).toEqual([]);
  });
});

describe("integrity issues", () => {
  it("reports a duplicate packId", () => {
    const resolution = resolveKnowledgePacks([pack({ packId: "a" }), pack({ packId: "a" })]);
    expect(resolution.issues.map((issue) => issue.code)).toContain(
      KnowledgeErrorCodes.PACK_DUPLICATE,
    );
    expect(isResolutionClean(resolution)).toBe(false);
  });

  it("reports a missing dependency", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "a", dependencies: [{ packId: "absent-pack" }] }),
    ]);
    const issue = resolution.issues.find(
      (entry) => entry.code === KnowledgeErrorCodes.DEPENDENCY_MISSING,
    );
    expect(issue?.packIds).toEqual(["a", "absent-pack"]);
  });

  it("reports a direct dependency cycle", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "a", dependencies: [{ packId: "b" }] }),
      pack({ packId: "b", dependencies: [{ packId: "a" }] }),
    ]);
    const cycles = resolution.issues.filter(
      (entry) => entry.code === KnowledgeErrorCodes.DEPENDENCY_CYCLE,
    );
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0]?.packIds ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("reports a longer dependency cycle once", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "a", dependencies: [{ packId: "b" }] }),
      pack({ packId: "b", dependencies: [{ packId: "c" }] }),
      pack({ packId: "c", dependencies: [{ packId: "a" }] }),
    ]);
    const cycles = resolution.issues.filter(
      (entry) => entry.code === KnowledgeErrorCodes.DEPENDENCY_CYCLE,
    );
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0]?.packIds ?? [])].sort()).toEqual(["a", "b", "c"]);
  });

  it("reports a self-dependency as a cycle", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "a", dependencies: [{ packId: "a" }] }),
    ]);
    expect(resolution.issues.map((issue) => issue.code)).toContain(
      KnowledgeErrorCodes.DEPENDENCY_CYCLE,
    );
  });

  it("accepts a diamond dependency without calling it a cycle", () => {
    const resolution = resolveKnowledgePacks([
      pack({ packId: "top", dependencies: [{ packId: "left" }, { packId: "right" }] }),
      pack({ packId: "left", dependencies: [{ packId: "base" }] }),
      pack({ packId: "right", dependencies: [{ packId: "base" }] }),
      pack({ packId: "base" }),
    ]);
    expect(resolution.issues).toEqual([]);
  });

  it("reports a missing declared resource when a resolver is supplied", () => {
    const present = new Set(["SOP.md"]);
    const resolution = resolveKnowledgePacks(
      [
        pack({
          packId: "a",
          includes: ["SOP.md", "absent.md"],
          tests: ["tests/a.test.ts"],
          negativeKnowledge: ["known-failures.md"],
        }),
      ],
      { resourceExists: (_packId, path) => present.has(path) },
    );
    const missing = resolution.issues.filter(
      (entry) => entry.code === KnowledgeErrorCodes.RESOURCE_MISSING,
    );
    expect(missing.map((entry) => entry.path)).toEqual([
      "absent.md",
      "tests/a.test.ts",
      "known-failures.md",
    ]);
  });

  it("records resource paths without checking them when no resolver is supplied", () => {
    // Core performs no filesystem access (contract §7); checking is opt-in.
    const resolution = resolveKnowledgePacks([pack({ packId: "a", includes: ["absent.md"] })]);
    expect(resolution.issues).toEqual([]);
  });
});

describe("toKnowledgePackRefs (contract §6.2, §20)", () => {
  const packs = [
    pack({
      packId: "example-show-editorial",
      version: "2",
      scope: { show: "example-show" },
      sourceRevision: "revision-a",
      contentHash: "a".repeat(64),
    }),
    pack({ packId: "example-global-style", authority: "advisory" }),
  ];

  it("produces refs that validate inside a RunManifest", () => {
    const resolution = resolveKnowledgePacks(packs, { context: { show: "example-show" } });
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      runId: "run-a",
      episode: {
        schemaVersion: SCHEMA_VERSION,
        episodeId: "show:example-show:episode:episode-a",
        showId: "example-show",
      },
      workflowId: "workflow-a",
      workflowVersion: "1",
      status: "created",
      knowledgePacks: toKnowledgePackRefs(resolution),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = validate("RunManifest", manifest);
    expect(result.ok).toBe(true);
  });

  it("writes out the effective precedence so the snapshot survives a ladder change", () => {
    const resolution = resolveKnowledgePacks(packs, { context: { show: "example-show" } });
    const refs = toKnowledgePackRefs(resolution);
    const editorial = refs.find((ref) => ref.packId === "example-show-editorial");
    expect(editorial?.precedence).toBe(PRECEDENCE_TIER_STRIDE);
  });

  it("carries contentHash and sourceRevision through", () => {
    const refs = toKnowledgePackRefs(
      resolveKnowledgePacks(packs, { context: { show: "example-show" } }),
    );
    const editorial = refs.find((ref) => ref.packId === "example-show-editorial");
    expect(editorial?.contentHash).toBe("a".repeat(64));
    expect(editorial?.sourceRevision).toBe("revision-a");
  });

  it("omits absent optional fields rather than setting them undefined", () => {
    const refs = toKnowledgePackRefs(resolveKnowledgePacks([pack({ packId: "bare" })]));
    expect(Object.keys(refs[0] ?? {}).sort()).toEqual([
      "authority",
      "packId",
      "precedence",
      "version",
    ]);
  });

  it("is deterministic and strongest-first", () => {
    const resolution = resolveKnowledgePacks(packs, { context: { show: "example-show" } });
    const once = toKnowledgePackRefs(resolution).map((ref) => ref.packId);
    const twice = toKnowledgePackRefs(
      resolveKnowledgePacks([...packs].reverse(), { context: { show: "example-show" } }),
    ).map((ref) => ref.packId);
    expect(once).toEqual(["example-show-editorial", "example-global-style"]);
    expect(twice).toEqual(once);
  });

  it("excludes packs that do not apply", () => {
    const refs = toKnowledgePackRefs(resolveKnowledgePacks(packs, { context: {} }));
    expect(refs.map((ref) => ref.packId)).toEqual(["example-global-style"]);
  });
});
