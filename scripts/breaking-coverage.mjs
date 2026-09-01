/**
 * Surface extraction and the admission rule for {@link ../scripts/check-breaking-notes.mjs}, as
 * pure functions.
 *
 * Extracted so the false-green paths are testable without a git worktree and a full build. The
 * first version of this rule was validated by four hand-run cases described in a PR body, and a
 * review pointed out the obvious: **review evidence is not a gate.** Those cases are now committed
 * against this function.
 */
import { createHash } from "node:crypto";

/**
 * Extract the declarations relevant to the breaking-notes check from one built `.d.ts`.
 *
 * `declarations` maps each key to the **set** of declaration kinds seen for it, never to the last
 * one. TypeScript legally admits the same exported name in the type and the value namespace —
 * `export interface Foo {…}` beside `export declare const Foo: …` — so a scalar makes the result
 * depend on which declaration the emitter happened to print second. Both directions were reachable:
 * an unchanged interface followed by a same-named `const` read as a kind change that never
 * happened, and an interface replaced by a union alias while the `const` survived read as no change
 * at all, which is the silent omission this detector exists to close.
 */
export function declarationSurface(text, pkg) {
  const surface = new Map();
  const declarations = new Map();
  const opaque = new Map();

  for (const match of text.matchAll(
    /^export (?:declare )?(?:abstract )?(class|interface|type|function|const|enum) ([A-Za-z_$][\w$]*)/gm,
  )) {
    const key = `${pkg}:${match[2]}`;
    if (!surface.has(key)) surface.set(key, new Set());
    const kinds = declarations.get(key) ?? new Set();
    kinds.add(match[1]);
    declarations.set(key, kinds);
  }

  // A Zod-inferred alias carries no shape of its own. Digest the declaration it points at so the
  // check can name a changed, unclassifiable surface without pretending it knows optionality.
  for (const alias of text.matchAll(
    /^export type ([A-Za-z_$][\w$]*) = z\.infer<typeof ([A-Za-z_$][\w$]*)>/gm,
  )) {
    const schema = text.match(
      new RegExp(`^export declare const ${alias[2]}:([\\s\\S]*?)^(?=export |declare |$)`, "m"),
    );
    if (schema !== null) {
      opaque.set(`${pkg}:${alias[1]}`, createHash("sha256").update(schema[1]).digest("hex"));
    }
  }

  // Required members of exported **interfaces**. The brace must open on the declaration line: a
  // one-line type alias has no body, and skipping to the next `{` attributes another declaration's
  // members to it. Zod-inferred bodies are opaque because optionality lives in `z.ZodOptional<…>`.
  for (const block of text.matchAll(
    /^export (?:declare )?interface ([A-Za-z_$][\w$]*)[^{\n]*\{$([\s\S]*?)^\}/gm,
  )) {
    const key = `${pkg}:${block[1]}`;
    if (/z\.Zod/.test(block[2])) {
      opaque.set(key, createHash("sha256").update(block[2]).digest("hex"));
      continue;
    }
    const members = surface.get(key) ?? new Set();
    for (const member of block[2].matchAll(/^\s{4}(?:readonly )?([A-Za-z_$][\w$]*)(\??):/gm)) {
      if (member[2] !== "?") members.add(member[1]);
    }
    surface.set(key, members);
  }

  return { surface, declarations, opaque };
}

/**
 * Fold one file's extracted declarations into an accumulating whole-tree surface.
 *
 * Union, never overwrite, for the same reason the kinds are a set one level down: a package emits
 * many `.d.ts` files, and a symbol declared as an interface in one and as a value in another is the
 * same legal merge spread across two files. `Map.set` there loses whichever half was read first —
 * the members if the value file sorts later, the `interface` kind if it sorts earlier — and the
 * second of those silences the detector exactly as the scalar did.
 */
export function mergeDeclarationSurface(whole, part) {
  for (const [key, members] of part.surface) {
    const into = whole.surface.get(key) ?? new Set();
    for (const member of members) into.add(member);
    whole.surface.set(key, into);
  }
  for (const [key, kinds] of part.declarations) {
    const into = whole.declarations.get(key) ?? new Set();
    for (const kind of kinds) into.add(kind);
    whole.declarations.set(key, into);
  }
  for (const [key, digest] of part.opaque) whole.opaque.set(key, digest);
  return whole;
}

/** An empty accumulator for {@link mergeDeclarationSurface}. */
export function emptyDeclarationSurface() {
  return { surface: new Map(), declarations: new Map(), opaque: new Map() };
}

/** Mechanical breaking findings between two extracted declaration surfaces. */
export function breakingFindings(base, head, baseDeclarations, headDeclarations) {
  const findings = [];
  for (const [key, members] of base) {
    if (!head.has(key)) {
      findings.push(`removed export: ${key}`);
      continue;
    }

    // Detection should be monotone with disruption: replacing a member-bearing interface with an
    // untracked declaration must not be less visible than adding one required member. The Zod case
    // in #236 remains a named blind spot; this mechanically classifiable case must not be silent.
    // Interface **presence**, not the recorded kind: a same-named value declaration is a legal
    // merge partner, not a replacement, so it neither creates nor conceals a break.
    if (
      members.size > 0 &&
      baseDeclarations.get(key)?.has("interface") === true &&
      headDeclarations.get(key)?.has("interface") !== true
    ) {
      findings.push(`declaration kind changed: ${key}`);
      continue;
    }

    const now = head.get(key) ?? new Set();
    for (const member of now) {
      if (!members.has(member)) findings.push(`newly required member: ${key}.${member}`);
    }
  }
  return findings;
}

/** The `MAJOR.MINOR.PATCH[-pre]` token, optionally followed by ` — anything`, and nothing else. */
const headingMatchesVersion = (heading, version) =>
  heading === version || heading.startsWith(`${version} `) || heading.startsWith(`${version}\t`);

/**
 * Select the CHANGELOG section the notes for this tree must live in.
 *
 * Exact token match, never `startsWith` on the raw string: a tree at `0.2.0-next.2` binds to a
 * `0.2.0-next.20` heading under a prefix test, which silently accepts a *different release's*
 * notes. `Unreleased` is the fallback because notes are legitimately written before the bump
 * commit; a *previous* version's heading is never the fallback.
 */
export function selectSection(changelog, version) {
  const sections = new Map();
  for (const part of changelog.split(/^## /m).slice(1)) {
    sections.set(part.split("\n")[0].trim(), part);
  }
  const heading = [...sections.keys()].find((key) => headingMatchesVersion(key, version));
  if (heading !== undefined) return { heading, body: sections.get(heading) ?? "" };
  const unreleased = sections.get("Unreleased");
  if (unreleased !== undefined) return { heading: "Unreleased", body: unreleased };
  return { heading: undefined, body: "" };
}

/**
 * Waivers declared **in this section only**, each with a non-empty reason.
 *
 * Scoped to the section because a waiver in an old release would otherwise excuse the same symbol
 * forever — the same defect as binding to a previous version's heading, one field over.
 *
 * A waiver-shaped comment with no reason is not a lenient waiver; it is a **malformed** one, and
 * returned as an error rather than ignored. Silently accepting it would make the documented
 * requirement decorative, which is the failure this whole gate exists to prevent.
 */
export function parseWaivers(sectionBody) {
  const waived = new Map();
  const malformed = [];
  for (const match of sectionBody.matchAll(/<!--\s*breaking-waiver:([^>]*?)-->/g)) {
    const raw = (match[1] ?? "").trim();
    const [symbol, ...rest] = raw.split(/\s+[—-]\s+/);
    const reason = rest.join(" — ").trim();
    if (symbol === undefined || symbol.trim() === "" || reason === "") {
      malformed.push(raw === "" ? "<empty>" : raw);
      continue;
    }
    waived.set(symbol.trim(), reason);
  }
  return { waived, malformed };
}

/**
 * Which findings the section does not account for.
 *
 * Matched on an **exact marker**, not on prose. The previous rule asked whether each dotted part of
 * a symbol appeared anywhere in the section, so `SpendGrant` in one paragraph and `scope` in an
 * unrelated sentence satisfied `SpendGrant.scope`. A gate that a coincidence can satisfy is not a
 * gate, and prose is full of coincidences.
 *
 * The marker is a comment, so it does not appear in rendered notes:
 *
 *     <!-- breaking: pkg:Symbol.member -->
 */
export function uncoveredFindings(findings, sectionBody, waived) {
  const marked = new Set(
    [...sectionBody.matchAll(/<!--\s*breaking:\s*([^\s>]+)\s*-->/g)].map((match) => match[1]),
  );
  return findings.filter((finding) => {
    const symbol = finding.replace(
      /^(removed export|newly required member|declaration kind changed): /,
      "",
    );
    return !marked.has(symbol) && !waived.has(symbol);
  });
}
