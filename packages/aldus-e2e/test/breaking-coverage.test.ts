import { describe, expect, it } from "vitest";

import {
  breakingFindings,
  declarationSurface,
  emptyDeclarationSurface,
  mergeDeclarationSurface,
  parseWaivers,
  selectSection,
  uncoveredFindings,
} from "../../../scripts/breaking-coverage.mjs";

/**
 * Regression cases for the breaking-notes admission rule.
 *
 * Every case here is a **false green** the first implementation allowed. They were found by review,
 * not by use, and the review's sharpest point was that the four cases validating that version lived
 * in a PR body: review evidence is not a gate, and a green CI that never exercises the holes says
 * nothing about them.
 */

const FINDING = "newly required member: aldus-gate-engine:SpendGrant.scope";
const SYMBOL = "aldus-gate-engine:SpendGrant.scope";

const changelogWith = (heading: string, body: string): string =>
  `# Changelog\n\n## ${heading}\n\n${body}\n\n## 0.1.0 — 2026-08-18\n\nold notes.\n`;

const findingsFor = (baseText: string, headText: string): string[] => {
  const base = declarationSurface(baseText, "aldus-core");
  const head = declarationSurface(headText, "aldus-core");
  return breakingFindings(base.surface, head.surface, base.declarations, head.declarations);
};

describe("breakingFindings", () => {
  const MEMBER_INTERFACE = `export interface ReworkVerdict {
    readonly blockingFindingClasses: readonly string[];
    findingCount: number;
}
`;

  it("reports the ReworkVerdict interface-to-discriminated-union change", () => {
    const union = `export type ReworkVerdict =
  | { kind: "evaluated"; findingCount: number }
  | { kind: "not_evaluated"; reason: string };
`;
    expect(findingsFor(MEMBER_INTERFACE, union)).toEqual([
      "declaration kind changed: aldus-core:ReworkVerdict",
    ]);
  });

  it.each([
    ["intersection", "export type ReworkVerdict = EvaluatedVerdict & AuditEvidence;\n"],
    ["plain alias", "export type ReworkVerdict = EvaluatedVerdict;\n"],
    ["other non-interface declaration", "export declare function ReworkVerdict(): void;\n"],
  ])("reports an interface changed to an %s", (_shape, declaration) => {
    expect(findingsFor(MEMBER_INTERFACE, declaration)).toEqual([
      "declaration kind changed: aldus-core:ReworkVerdict",
    ]);
  });

  it("uses only the existing removed-export path when the interface is gone", () => {
    expect(findingsFor(MEMBER_INTERFACE, "export type SomethingElse = string;\n")).toEqual([
      "removed export: aldus-core:ReworkVerdict",
    ]);
  });

  it.each([
    ["empty", "export interface ReworkVerdict {\n}\n"],
    ["optional-only", "export interface ReworkVerdict {\n    reason?: string;\n}\n"],
  ])("does not infer a kind break from a legitimately %s base interface", (_shape, base) => {
    expect(findingsFor(base, "export type ReworkVerdict = EvaluatedVerdict;\n")).toEqual([]);
  });

  it("does not treat removing every required member from a surviving interface as a kind change", () => {
    expect(findingsFor(MEMBER_INTERFACE, "export interface ReworkVerdict {\n}\n")).toEqual([]);
  });

  it("keeps unchanged interfaces silent and still reports newly required members", () => {
    expect(findingsFor(MEMBER_INTERFACE, MEMBER_INTERFACE)).toEqual([]);
    expect(
      findingsFor(
        MEMBER_INTERFACE,
        MEMBER_INTERFACE.replace(
          "    findingCount: number;",
          "    findingCount: number;\n    kind: string;",
        ),
      ),
    ).toEqual(["newly required member: aldus-core:ReworkVerdict.kind"]);
  });

  it("leaves unsupported aliases silent and the #236 Zod blind spot named by its digest", () => {
    expect(
      findingsFor("export type Alias = string;\n", "export type Alias = string | number;\n"),
    ).toEqual([]);

    const before = declarationSurface(
      `export declare const policySchema: z.ZodObject<{\n    maxRounds: z.ZodNumber;\n}>;\nexport type ReworkPolicy = z.infer<typeof policySchema>;\n`,
      "aldus-core",
    );
    const after = declarationSurface(
      `export declare const policySchema: z.ZodObject<{\n    maxRounds: z.ZodNumber;\n    note: z.ZodOptional<z.ZodString>;\n}>;\nexport type ReworkPolicy = z.infer<typeof policySchema>;\n`,
      "aldus-core",
    );
    expect(
      breakingFindings(before.surface, after.surface, before.declarations, after.declarations),
    ).toEqual([]);
    expect(after.opaque.get("aldus-core:ReworkPolicy")).not.toBe(
      before.opaque.get("aldus-core:ReworkPolicy"),
    );
  });

  /**
   * A symbol legally occupies the type and the value namespace at once. Both orders are emitted in
   * practice, and a scalar "last declaration kind" made the detector's answer depend on which one
   * `tsc` printed second — a false positive in one order and a silent miss in the other.
   */
  describe("a legal type/value namespace merge", () => {
    const VALUE = "export declare const ReworkVerdict: (input: unknown) => ReworkVerdict;\n";
    const UNION = `export type ReworkVerdict =
  | { kind: "evaluated"; findingCount: number }
  | { kind: "not_evaluated"; reason: string };
`;
    const orders: readonly [string, (declaration: string) => string][] = [
      ["type first", (declaration) => `${declaration}${VALUE}`],
      ["value first", (declaration) => `${VALUE}${declaration}`],
    ];

    it.each(orders)("stays silent for an unchanged merged interface (%s)", (_order, merge) => {
      expect(findingsFor(merge(MEMBER_INTERFACE), merge(MEMBER_INTERFACE))).toEqual([]);
    });

    it.each(orders)(
      "still reports a newly required member on a merged interface (%s)",
      (_order, merge) => {
        expect(
          findingsFor(
            merge(MEMBER_INTERFACE),
            merge(
              MEMBER_INTERFACE.replace(
                "    findingCount: number;",
                "    findingCount: number;\n    kind: string;",
              ),
            ),
          ),
        ).toEqual(["newly required member: aldus-core:ReworkVerdict.kind"]);
      },
    );

    it.each(orders)(
      "reports the kind change when the interface becomes a union and the value survives (%s)",
      (_order, merge) => {
        expect(findingsFor(merge(MEMBER_INTERFACE), merge(UNION))).toEqual([
          "declaration kind changed: aldus-core:ReworkVerdict",
        ]);
      },
    );

    it.each(orders)(
      "reports the kind change for a plain alias with a surviving value (%s)",
      (_order, merge) => {
        expect(
          findingsFor(merge(MEMBER_INTERFACE), merge("export type ReworkVerdict = Evaluated;\n")),
        ).toEqual(["declaration kind changed: aldus-core:ReworkVerdict"]);
      },
    );

    it.each(orders)(
      "reports removal once, never also as a kind change, when the merge is gone (%s)",
      (_order, merge) => {
        expect(
          findingsFor(merge(MEMBER_INTERFACE), "export type SomethingElse = string;\n"),
        ).toEqual(["removed export: aldus-core:ReworkVerdict"]);
      },
    );

    it.each(orders)(
      "does not infer a kind break from an empty merged base interface (%s)",
      (_order, merge) => {
        expect(findingsFor(merge("export interface ReworkVerdict {\n}\n"), merge(UNION))).toEqual(
          [],
        );
      },
    );

    it.each(orders)(
      "leaves the #236 Zod blind spot silent when merged with a value (%s)",
      (_order, merge) => {
        const zod = `export interface ReworkVerdict {\n    findingCount: z.ZodNumber;\n}\n`;
        expect(findingsFor(merge(zod), merge(UNION))).toEqual([]);
      },
    );

    // The false-positive half, and the one a symmetric case cannot reach: the merge partner is
    // *added* (or dropped) between the two trees, so a scalar kind disagrees across them while the
    // interface itself never moved.
    it.each(orders)(
      "does not report a kind change when a same-named value is added beside an unchanged interface (%s)",
      (_order, merge) => {
        expect(findingsFor(MEMBER_INTERFACE, merge(MEMBER_INTERFACE))).toEqual([]);
      },
    );

    it.each(orders)(
      "does not report a kind change when a same-named value is dropped from beside an unchanged interface (%s)",
      (_order, merge) => {
        expect(findingsFor(merge(MEMBER_INTERFACE), MEMBER_INTERFACE)).toEqual([]);
      },
    );

    it.each(orders)(
      "still reports a newly required member when the value is added in the same release (%s)",
      (_order, merge) => {
        expect(
          findingsFor(
            MEMBER_INTERFACE,
            merge(
              MEMBER_INTERFACE.replace(
                "    findingCount: number;",
                "    findingCount: number;\n    kind: string;",
              ),
            ),
          ),
        ).toEqual(["newly required member: aldus-core:ReworkVerdict.kind"]);
      },
    );

    it.each(orders)(
      "still reports the kind change when the value is added in the same release (%s)",
      (_order, merge) => {
        expect(findingsFor(MEMBER_INTERFACE, merge(UNION))).toEqual([
          "declaration kind changed: aldus-core:ReworkVerdict",
        ]);
      },
    );

    it("records every kind it saw, in either order", () => {
      const typeFirst = declarationSurface(`${MEMBER_INTERFACE}${VALUE}`, "aldus-core");
      const valueFirst = declarationSurface(`${VALUE}${MEMBER_INTERFACE}`, "aldus-core");
      const expected = new Set(["interface", "const"]);
      expect(typeFirst.declarations.get("aldus-core:ReworkVerdict")).toEqual(expected);
      expect(valueFirst.declarations.get("aldus-core:ReworkVerdict")).toEqual(expected);
      expect(typeFirst.surface.get("aldus-core:ReworkVerdict")).toEqual(
        new Set(["blockingFindingClasses", "findingCount"]),
      );
      expect(valueFirst.surface.get("aldus-core:ReworkVerdict")).toEqual(
        new Set(["blockingFindingClasses", "findingCount"]),
      );
    });

    it.each(orders)("is idempotent across repeated evaluation (%s)", (_order, merge) => {
      const base = declarationSurface(merge(MEMBER_INTERFACE), "aldus-core");
      const head = declarationSurface(merge(UNION), "aldus-core");
      const evaluate = (): string[] =>
        breakingFindings(base.surface, head.surface, base.declarations, head.declarations);
      expect(evaluate()).toEqual(evaluate());
      expect(evaluate()).toEqual(["declaration kind changed: aldus-core:ReworkVerdict"]);
    });
  });

  /**
   * The same merge one level up: a package emits many `.d.ts` files, so the two halves of a legal
   * merge can arrive from different files. Folding them with `Map.set` loses whichever half is read
   * first — which is the scalar defect, re-created by the caller.
   */
  describe("merging the per-file surfaces of one package", () => {
    const VALUE_FILE = "export declare const ReworkVerdict: (input: unknown) => ReworkVerdict;\n";

    const foldedFindings = (baseFiles: string[], headFiles: string[]): string[] => {
      const fold = (files: string[]): ReturnType<typeof emptyDeclarationSurface> =>
        files.reduce(
          (whole, text) => mergeDeclarationSurface(whole, declarationSurface(text, "aldus-core")),
          emptyDeclarationSurface(),
        );
      const base = fold(baseFiles);
      const head = fold(headFiles);
      return breakingFindings(base.surface, head.surface, base.declarations, head.declarations);
    };

    it.each([
      ["interface file first", [MEMBER_INTERFACE, VALUE_FILE]],
      ["value file first", [VALUE_FILE, MEMBER_INTERFACE]],
    ])("keeps an unchanged cross-file merge silent (%s)", (_order, files) => {
      expect(foldedFindings(files, files)).toEqual([]);
    });

    it.each([
      ["interface file first", (declaration: string): string[] => [declaration, VALUE_FILE]],
      ["value file first", (declaration: string): string[] => [VALUE_FILE, declaration]],
    ])("reports a cross-file interface-to-alias change (%s)", (_order, files) => {
      expect(
        foldedFindings(files(MEMBER_INTERFACE), files("export type ReworkVerdict = Evaluated;\n")),
      ).toEqual(["declaration kind changed: aldus-core:ReworkVerdict"]);
    });

    it.each([
      ["interface file first", [MEMBER_INTERFACE, VALUE_FILE]],
      ["value file first", [VALUE_FILE, MEMBER_INTERFACE]],
    ])("does not report a kind change when a value file is added (%s)", (_order, files) => {
      expect(foldedFindings([MEMBER_INTERFACE], files)).toEqual([]);
    });

    it("keeps the members contributed by whichever file declared them", () => {
      const whole = [VALUE_FILE, MEMBER_INTERFACE].reduce(
        (into, text) => mergeDeclarationSurface(into, declarationSurface(text, "aldus-core")),
        emptyDeclarationSurface(),
      );
      expect(whole.surface.get("aldus-core:ReworkVerdict")).toEqual(
        new Set(["blockingFindingClasses", "findingCount"]),
      );
      expect(whole.declarations.get("aldus-core:ReworkVerdict")).toEqual(
        new Set(["interface", "const"]),
      );
    });
  });

  it("produces the same finding on repeated evaluation without mutating either surface", () => {
    const base = declarationSurface(MEMBER_INTERFACE, "aldus-core");
    const head = declarationSurface(
      "export type ReworkVerdict = EvaluatedVerdict | NoEvaluationVerdict;\n",
      "aldus-core",
    );
    const evaluate = (): string[] =>
      breakingFindings(base.surface, head.surface, base.declarations, head.declarations);

    expect(evaluate()).toEqual(evaluate());
    expect(base.surface.get("aldus-core:ReworkVerdict")).toEqual(
      new Set(["blockingFindingClasses", "findingCount"]),
    );
    expect(head.surface.get("aldus-core:ReworkVerdict")).toEqual(new Set());
  });
});

describe("selectSection", () => {
  it("binds a version to its own heading", () => {
    const changelog = changelogWith("0.2.0-next.23 — 2026-08-25", "### BREAKING\n\nnotes.");
    expect(selectSection(changelog, "0.2.0-next.23").heading).toBe("0.2.0-next.23 — 2026-08-25");
  });

  it("does not let a prefix bind to a different release", () => {
    // `0.2.0-next.2`.startsWith-matching `0.2.0-next.20` accepts another release's notes wholesale.
    const changelog = changelogWith("0.2.0-next.20 — 2026-08-20", "### BREAKING\n\nnotes.");
    const selected = selectSection(changelog, "0.2.0-next.2");
    expect(selected.heading).not.toBe("0.2.0-next.20 — 2026-08-20");
  });

  it("falls back to Unreleased, never to a previous version's heading", () => {
    const changelog = `# Changelog\n\n## Unreleased\n\npending.\n\n## 0.2.0-next.20 — 2026-08-20\n\n### BREAKING\n\nold.\n`;
    expect(selectSection(changelog, "0.2.0-next.23").heading).toBe("Unreleased");
  });

  it("reports no heading when neither exists", () => {
    const changelog = `# Changelog\n\n## 0.1.0 — 2026-08-18\n\nold.\n`;
    expect(selectSection(changelog, "0.2.0-next.23").heading).toBeUndefined();
  });
});

describe("parseWaivers", () => {
  it("accepts a waiver carrying a reason", () => {
    const { waived, malformed } = parseWaivers(
      `<!-- breaking-waiver: ${SYMBOL} — internal only -->`,
    );
    expect(malformed).toEqual([]);
    expect(waived.get(SYMBOL)).toBe("internal only");
  });

  it("refuses a waiver with no reason rather than accepting it leniently", () => {
    // The documented form requires a reason. Accepting one without makes the requirement
    // decorative, which is the failure the gate exists to prevent.
    const { waived, malformed } = parseWaivers(`<!-- breaking-waiver: ${SYMBOL} -->`);
    expect(waived.size).toBe(0);
    expect(malformed).toHaveLength(1);
  });

  it("reads only the section it is given, so an old waiver cannot excuse a new finding", () => {
    // The caller passes the selected section; a waiver in a previous release is simply not in it.
    const { waived } = parseWaivers("### BREAKING\n\nnotes with no waiver.");
    expect(waived.size).toBe(0);
  });
});

describe("uncoveredFindings", () => {
  const empty = new Map<string, string>();

  it("counts a finding as covered only when explicitly marked", () => {
    const body = `### BREAKING\n\nmigration prose.\n\n<!-- breaking: ${SYMBOL} -->`;
    expect(uncoveredFindings([FINDING], body, empty)).toEqual([]);
  });

  it("covers a declaration-kind finding with the surviving export's marker", () => {
    const finding = "declaration kind changed: aldus-core:ReworkVerdict";
    const body = "### BREAKING\n\n<!-- breaking: aldus-core:ReworkVerdict -->";
    expect(uncoveredFindings([finding], body, empty)).toEqual([]);
  });

  it("does not accept a BREAKING heading that names nothing", () => {
    expect(uncoveredFindings([FINDING], "### BREAKING\n\nsomething changed.", empty)).toEqual([
      FINDING,
    ]);
  });

  it("does not accept the symbol's parts appearing in unrelated prose", () => {
    // The previous rule asked whether each dotted part appeared anywhere in the section, so a type
    // name in one paragraph and a member name in another satisfied the whole symbol.
    const body = "### BREAKING\n\n`SpendGrant` gained something.\n\nSeparately, `scope` is a word.";
    expect(uncoveredFindings([FINDING], body, empty)).toEqual([FINDING]);
  });

  it("documents one finding without covering the rest", () => {
    const other = "removed export: aldus-gate-engine:grantLimitsDigest";
    const body = `### BREAKING\n\n<!-- breaking: ${SYMBOL} -->`;
    expect(uncoveredFindings([FINDING, other], body, empty)).toEqual([other]);
  });

  it("treats a reasoned waiver as coverage", () => {
    const waived = new Map([[SYMBOL, "internal only"]]);
    expect(uncoveredFindings([FINDING], "### BREAKING\n\nnotes.", waived)).toEqual([]);
  });
});
