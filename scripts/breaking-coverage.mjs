/**
 * The admission rule for {@link ../scripts/check-breaking-notes.mjs}, as a pure function.
 *
 * Extracted so the false-green paths are testable without a git worktree and a full build. The
 * first version of this rule was validated by four hand-run cases described in a PR body, and a
 * review pointed out the obvious: **review evidence is not a gate.** Those cases are now committed
 * against this function.
 */

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
    const symbol = finding.replace(/^(removed export|newly required member): /, "");
    return !marked.has(symbol) && !waived.has(symbol);
  });
}
