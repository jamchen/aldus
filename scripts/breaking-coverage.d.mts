/**
 * Types for the breaking-notes admission rule.
 *
 * Declared rather than suppressed: the alternative was a `@ts-expect-error` on the import, which
 * turns a typed test of a money-adjacent gate into an untyped one, and this repository's style
 * forbids casting around strictness rather than respecting it.
 */

/** One `## ` section of a CHANGELOG, with the 1-based line its heading is on. */
export interface ChangelogSection {
  heading: string;
  body: string;
  line: number;
}

/** Every `## ` section, in file order — a list, so duplicate headings survive as duplicates. */
export declare function changelogSections(changelog: string): ChangelogSection[];

/**
 * The CHANGELOG section a tree's notes must live in, or a refusal.
 *
 * A discriminated union rather than an optional heading: zero matching sections and more than one
 * are both outcomes the caller must handle, and a shape that can express "the last of several"
 * is a shape in which last-write-wins is representable.
 */
export type SectionSelection =
  | { ok: true; heading: string; body: string }
  | {
      ok: false;
      reason: "no-section" | "duplicate-section";
      matches: { heading: string; line: number }[];
      diagnostic: string;
    };

/** Bind a version to exactly one CHANGELOG section, or refuse with a diagnostic. */
export declare function selectSection(changelog: string, version: string): SectionSelection;

/** Waivers declared in one section, and any that are waiver-shaped but malformed. */
export declare function parseWaivers(sectionBody: string): {
  waived: Map<string, string>;
  malformed: string[];
};

/** Findings the section neither marks nor waives. */
export declare function uncoveredFindings(
  findings: readonly string[],
  sectionBody: string,
  waived: Map<string, string>,
): string[];

export type DeclarationKind = "class" | "interface" | "type" | "function" | "const" | "enum";

/**
 * One tree's extracted declaration surface.
 *
 * `declarations` holds a **set** of kinds per key. A symbol legally occupies the type and the value
 * namespace at once, so a scalar kind records whichever declaration was emitted last.
 */
export interface DeclarationSurface {
  surface: Map<string, Set<string>>;
  declarations: Map<string, Set<DeclarationKind>>;
  opaque: Map<string, string>;
}

/** Extract the declarations relevant to the breaking-notes check from one built `.d.ts`. */
export declare function declarationSurface(text: string, pkg: string): DeclarationSurface;

/** Fold one file's extracted declarations into an accumulating whole-tree surface. */
export declare function mergeDeclarationSurface(
  whole: DeclarationSurface,
  part: DeclarationSurface,
): DeclarationSurface;

/** An empty accumulator for {@link mergeDeclarationSurface}. */
export declare function emptyDeclarationSurface(): DeclarationSurface;

/** Mechanical breaking findings between two extracted declaration surfaces. */
export declare function breakingFindings(
  base: Map<string, Set<string>>,
  head: Map<string, Set<string>>,
  baseDeclarations: Map<string, Set<DeclarationKind>>,
  headDeclarations: Map<string, Set<DeclarationKind>>,
): string[];
