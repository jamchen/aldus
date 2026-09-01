import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  breakingFindings,
  changelogSections,
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

describe("changelogSections", () => {
  it("keeps duplicate headings as separate sections, in file order, with their lines", () => {
    // A `Map` keyed by heading answers "which section" with the last one inserted and destroys the
    // evidence that there was more than one. That is how two `0.2.0-next.48` and two *different*
    // `0.2.0-next.49` sections lived in this repository's CHANGELOG unnoticed.
    const changelog = `# Changelog\n\n## 0.2.0-next.9 — 2026-08-27\n\nfirst.\n\n## 0.2.0-next.9 — 2026-08-27\n\nsecond.\n`;
    const sections = changelogSections(changelog);
    expect(sections.map((section) => [section.heading, section.line])).toEqual([
      ["0.2.0-next.9 — 2026-08-27", 3],
      ["0.2.0-next.9 — 2026-08-27", 7],
    ]);
    expect(sections.map((section) => section.body.includes("first."))).toEqual([true, false]);
  });

  it("does not read the preamble as a section, and counts lines through it", () => {
    const changelog = `# Changelog\n\nAll notable changes.\nSee the contract.\n\n## Unreleased\n\npending.\n`;
    expect(changelogSections(changelog)).toEqual([
      { heading: "Unreleased", body: "Unreleased\n\npending.\n", line: 6 },
    ]);
  });

  it("reads a CRLF file the same as its LF equivalent", () => {
    const lf = `# Changelog\n\n## Unreleased\n\npending.\n`;
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(changelogSections(crlf).map((section) => [section.heading, section.line])).toEqual(
      changelogSections(lf).map((section) => [section.heading, section.line]),
    );
  });
});

describe("selectSection", () => {
  const twice = (first: string, second: string): string =>
    `# Changelog\n\n## ${first}\n\nfirst body.\n\n## ${second}\n\nsecond body.\n\n## 0.1.0 — 2026-08-18\n\nold notes.\n`;

  it("binds a version to its own heading", () => {
    const changelog = changelogWith("0.2.0-next.23 — 2026-08-25", "### BREAKING\n\nnotes.");
    const selected = selectSection(changelog, "0.2.0-next.23");
    expect(selected.ok).toBe(true);
    expect(selected.ok && selected.heading).toBe("0.2.0-next.23 — 2026-08-25");
    expect(selected.ok && selected.body).toContain("### BREAKING");
  });

  it("does not let a prefix bind to a different release", () => {
    // `0.2.0-next.2`.startsWith-matching `0.2.0-next.20` accepts another release's notes wholesale.
    const changelog = changelogWith("0.2.0-next.20 — 2026-08-20", "### BREAKING\n\nnotes.");
    const selected = selectSection(changelog, "0.2.0-next.2");
    expect(selected.ok).toBe(false);
    expect(selected.ok === false && selected.reason).toBe("no-section");
  });

  it("falls back to Unreleased, never to a previous version's heading", () => {
    const changelog = `# Changelog\n\n## Unreleased\n\npending.\n\n## 0.2.0-next.20 — 2026-08-20\n\n### BREAKING\n\nold.\n`;
    const selected = selectSection(changelog, "0.2.0-next.23");
    expect(selected.ok && selected.heading).toBe("Unreleased");
  });

  it("refuses when neither the version nor Unreleased exists", () => {
    const changelog = `# Changelog\n\n## 0.1.0 — 2026-08-18\n\nold.\n`;
    const selected = selectSection(changelog, "0.2.0-next.23");
    expect(selected.ok).toBe(false);
    expect(selected.ok === false && selected.reason).toBe("no-section");
    expect(selected.ok === false && selected.diagnostic).toContain("0.2.0-next.23");
  });

  // Both declaration orders, with **different** bodies. The rule this replaces kept the last
  // duplicate, so exactly one of these orders silently returned the corrected notes and the other
  // silently returned the superseded ones — a test written in only the lucky order reports the
  // defect as absent. This is the live `0.2.0-next.49` pair, whose two bodies disagree about
  // whether criterion 7 is complete.
  const CORRECTED = "### Added\n\ncriterion 7 stays open.";
  const SUPERSEDED = "### Added\n\nthe loop explains where it is (criterion 7).";
  for (const [order, bodies] of [
    ["corrected first", [CORRECTED, SUPERSEDED]],
    ["corrected last", [SUPERSEDED, CORRECTED]],
  ] as const) {
    it(`refuses two sections for the target version (${order}), never selecting one`, () => {
      const changelog = `# Changelog\n\n## 0.2.0-next.49 — 2026-08-27\n\n${bodies[0]}\n\n## 0.2.0-next.49 — 2026-08-27\n\n${bodies[1]}\n`;
      const selected = selectSection(changelog, "0.2.0-next.49");
      expect(selected.ok).toBe(false);
      expect(selected.ok === false && selected.reason).toBe("duplicate-section");
      expect(selected.ok === false && selected.matches.map((match) => match.line)).toEqual([3, 9]);
      expect(selected.ok === false && selected.diagnostic).toContain("line 3");
      expect(selected.ok === false && selected.diagnostic).toContain("line 9");
      // No body at all is returned: the refusal carries the evidence, never a chosen section.
      expect("body" in selected).toBe(false);
    });
  }

  it("refuses byte-identical duplicates, which no content comparison would flag", () => {
    // The live `0.2.0-next.48` pair was identical. A rule that only refused *disagreeing* bodies
    // would have passed on it and left the ambiguity in the file.
    const body = "### BREAKING\n\nsame notes.";
    const changelog = `# Changelog\n\n## 0.2.0-next.48 — 2026-08-27\n\n${body}\n\n## 0.2.0-next.48 — 2026-08-27\n\n${body}\n`;
    expect(selectSection(changelog, "0.2.0-next.48").ok).toBe(false);
  });

  it("refuses two Unreleased sections rather than choosing between them", () => {
    const changelog = `# Changelog\n\n## Unreleased\n\nfirst.\n\n## Unreleased\n\nsecond.\n`;
    const selected = selectSection(changelog, "0.2.0-next.23");
    expect(selected.ok).toBe(false);
    expect(selected.ok === false && selected.reason).toBe("duplicate-section");
    expect(selected.ok === false && selected.diagnostic).toContain("Unreleased");
  });

  it("binds normally when some *other* version is duplicated", () => {
    // The false positive to avoid: an old duplicate is a defect in the file, not in this binding,
    // and refusing on it would block every release until an unrelated section is repaired.
    const changelog = `# Changelog\n\n## 0.2.0-next.23 — 2026-08-25\n\nmine.\n\n## 0.1.0 — 2026-08-18\n\nold.\n\n## 0.1.0 — 2026-08-18\n\nold again.\n`;
    const selected = selectSection(changelog, "0.2.0-next.23");
    expect(selected.ok && selected.heading).toBe("0.2.0-next.23 — 2026-08-25");
    expect(selected.ok && selected.body).toContain("mine.");
  });

  it("binds the right one of several distinct versions", () => {
    const changelog = `# Changelog\n\n## 0.2.0-next.24 — 2026-08-26\n\nnewer.\n\n## 0.2.0-next.23 — 2026-08-25\n\nmine.\n\n## 0.2.0-next.2 — 2026-08-19\n\nolder.\n`;
    const selected = selectSection(changelog, "0.2.0-next.23");
    expect(selected.ok && selected.body).toContain("mine.");
  });

  it("accepts a bare, a tab-separated and a trailing-whitespace heading", () => {
    for (const heading of [
      "0.2.0-next.23",
      "0.2.0-next.23\tstill this release",
      "0.2.0-next.23  ",
    ]) {
      const selected = selectSection(changelogWith(heading, "notes."), "0.2.0-next.23");
      expect(selected.ok).toBe(true);
    }
  });

  it("does not bind a heading whose version token is not where the match reads it", () => {
    // False positives the token rule must reject: a non-breaking space is not a separator, and a
    // version named mid-sentence is not that release's section. Both refuse rather than bind.
    for (const heading of ["0.2.0-next.23\u00a0— 2026-08-25", "Reverts 0.2.0-next.23"]) {
      const selected = selectSection(changelogWith(heading, "notes."), "0.2.0-next.23");
      expect(selected.ok).toBe(false);
    }
  });

  it("refuses CRLF duplicates too, with the same lines", () => {
    const lf = twice("0.2.0-next.49 — 2026-08-27", "0.2.0-next.49 — 2026-08-27");
    const selected = selectSection(lf.replace(/\n/g, "\r\n"), "0.2.0-next.49");
    expect(selected.ok).toBe(false);
    expect(selected.ok === false && selected.matches.map((match) => match.line)).toEqual([3, 7]);
  });

  it("binds this repository's own CHANGELOG and version to exactly one section", () => {
    // The live proof. Two `0.2.0-next.48` sections and two disagreeing `0.2.0-next.49` sections
    // reached `main` and no check saw them; a rule tested only on fixtures would not have either.
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const headings = changelogSections(changelog).map((section) => section.heading);
    expect(headings.length).toBe(new Set(headings).size);

    const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const selected = selectSection(changelog, version);
    expect(selected.ok === false ? selected.diagnostic : "").toBe("");
    expect(selected.ok && selected.heading.startsWith(`${version} `)).toBe(true);
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
