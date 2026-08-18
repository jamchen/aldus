# ADR-0006: Knowledge Pack manifest, precedence, and conflict model

- Status: Accepted
- Date: 2026-08-18
- Closes: nothing in §25 directly; settles the design questions WP-09 raised
- Relates to: §4.1, §4.2, §9 Show/Host/Knowledge Packs, §6.2, §20, ADR-0003, ADR-0004

## Context

§4.1 lists "Knowledge Pack discovery and precedence" among what Aldus Core owns, so the loader
belongs in `@aldus-runtime/core`. §9.1 sketches a manifest and lists what a loaded pack should expose.
§9.2 gives a default precedence chain and one hard requirement: "Conflicts MUST be detectable.
Silent last-write-wins behavior SHOULD be avoided for normative rules."

Four things about that are underdetermined, and each would be expensive to change later because
each shapes a public API or an authored file format.

1. §9.1 writes its example manifest in YAML. Does Core parse YAML?
2. §9.2's middle tier — "provider / voice / model / script form" — is a list of examples, and
   §15.2 adds language to it. How does Core order packs without naming a provider (§4.2)?
3. Conflict detection requires knowing _what two packs disagree about_. But §1.2 makes
   "convert all production knowledge into YAML or a database" an explicit non-goal, and §9.1
   keeps knowledge as Markdown, fixtures, scripts, and examples. Core cannot read a Markdown
   file and decide two packs contradict each other.
4. `authority` and `precedence` are independent axes. Which wins when they disagree?

## Decision

### 1. The manifest is a Core schema; source parsing is injectable

`KnowledgePackManifest` joins the Core schema registry. Its field list implements §9.1's "every
loaded pack SHOULD expose" list directly, plus a declared home for §9.3 negative knowledge.

**Core takes no YAML dependency.** JSON is parsed natively; every other authoring format arrives
through an injected `ManifestSourceParser`. A parser for one authoring format is an
adopter-shaped concern (§4.2): an adopter authoring in TOML or front-matter should not have to
fork Core, and one authoring in JSON should not carry a YAML parser it never uses. Supporting
§9.1's YAML example is one function an adopter supplies.

One narrow accommodation is made in the opposite direction: §9.1's example writes `version: 1`,
which both YAML and JSON decode as a _number_, while `KnowledgePackRef.version` is a string and
must stay one so a manifest and the reference snapshotted from it agree field-for-field. The
parser coerces a numeric `version` before validation, so the contract's own example parses as
written. Nothing else is coerced — lenient parsing hides authoring mistakes.

`includes`, `tests`, and `negativeKnowledge` are resource **paths**. Core records and resolves
them; it never parses what is behind them (§9.1, §1.2).

### 2. The precedence ladder is configurable data

`DEFAULT_PRECEDENCE_LADDER` transcribes §9.2's chain as an ordered list of tiers, each naming
the scope dimensions that place a pack in it. It is a default a caller replaces or extends, not
a definition. Scope stays `Record<string, string>` throughout — Core names no provider (§4.2).

A scope dimension the ladder does not recognise **does not change a pack's tier**. It is
reported in `PackResolution.unknownDimensions` instead. Guessing where an unrecognised dimension
belongs would silently reorder precedence, which is exactly the class of failure §9.2 asks to be
made detectable. A pack scoped only by an unknown dimension still resolves; it sits at the
global tier until the ladder is extended.

An explicit `precedence` on a manifest overrides the derived tier value. Derived values are
spaced by `PRECEDENCE_TIER_STRIDE` so an explicit value can slot between two tiers without
renumbering the ladder.

### 3. Conflicts are detected between declared claims, not inferred from content

A manifest declares `provides: string[]` — the claim keys it asserts authority over. Keys are
opaque to Core; an adopter chooses their granularity.

This is what makes §9.2 satisfiable without violating §1.2. Core compares _declarations_, never
prose. A pack that declares nothing participates in precedence but can never conflict, which is
the correct behaviour for a pack that only contributes examples or fixtures.

**A conflict is: two or more `normative` packs holding the same claim key at the same effective
precedence.** It is reported, never resolved.

Deliberately _not_ conflicts:

- a normative pack beating an advisory one — that is a normal resolution, and reporting it would
  turn the conflict report into noise an operator learns to ignore;
- a normative tie _beneath_ an outright winner — the key resolves unambiguously;
- tied advisory or example packs — §9.2 scopes its requirement to "normative rules".

### 4. Authority outranks precedence

Ordering is `authority` first, `precedence` second, `packId` last for stability.

"Authority" means how binding a pack's content is (§9.1). An `example` pack scoped to an episode
must not override a `normative` global rule merely by sitting on a more specific rung — that
would make an illustration more authoritative than a rule. Precedence orders packs _of equal
bindingness_ by scope specificity, which is what §9.2's chain describes.

`deprecated` packs are excluded from resolution entirely but are still returned in the report.
§9.3 wants superseded guidance to stay **discoverable**, which is not the same as letting it win
a claim.

### 5. Resolution returns a report, and throws nothing

`resolveKnowledgePacks` returns winners, conflicts, and structural issues. An ambiguous or
broken pack set is an operational condition an operator acts on, not an exception. A resolver
that threw would force callers into try/catch to learn something they need to _display_.

### 6. No filesystem access, and no discovery in Core

Packs reach the resolver as manifests the caller supplies; resource existence is checked through
an injected `ResourceResolver`. §7 keeps core models independent of physical storage, and packs
may live in a working tree, a Git object store, or an archive. Filesystem discovery belongs to
the file store (WP-02) or the CLI (WP-08).

### 7. `SCHEMA_VERSION` moves to `1.2`

Adding a record type is additive (ADR-0003, and the precedent set by ADR-0004's 1.0→1.1 bump).
Every `1.0` and `1.1` record stays readable. New fixtures are pinned at `1.2`; older fixtures are
left untouched and must keep validating, which is what proves the same-major rule.

## Consequences

- Conflict detection is only as good as pack authors' `provides` declarations. A pack that
  under-declares will silently fail to conflict. That is the unavoidable cost of §1.2: the
  alternative is Core parsing editorial Markdown, which it must not do. The manifest field is
  documented as the conflict mechanism so under-declaring is a visible authoring choice rather
  than a hidden one.
- An adopter must supply a YAML parser to author manifests the way §9.1 illustrates. One
  function, injected at the call site.
- Because the ladder is data, two callers resolving the same packs with different ladders get
  different answers. `toKnowledgePackRefs` therefore writes the _effective_ precedence into the
  Run snapshot rather than leaving it to be recomputed — §20 requires a completed Run to stay
  explicable after its packs, and its ladder, have moved on.
- Authority-over-precedence is a judgement the contract does not state outright. It is recorded
  here and pinned by a test so that reversing it is a deliberate act.

## Alternatives considered

- **Bundle a YAML parser in Core.** Rejected: an authoring format is adopter-shaped (§4.2), and
  it would put a transitive dependency in every consumer for a format some will never use.
- **Infer conflicts from pack content.** Rejected: requires Core to parse and understand
  editorial Markdown, which §1.2 rules out and §4.2 forbids.
- **Enumerate scope dimensions as a union type.** Rejected: §9.2's own list is illustrative,
  §15.2 already extends it, and naming `provider` would put a provider concept in Core (§4.2).
- **Treat any tie as a conflict, including advisory ones.** Rejected: §9.2 scopes the
  requirement to normative rules, and over-reporting trains operators to ignore the report.
- **Precedence over authority.** Rejected: it lets an `example` pack override a `normative` one,
  which contradicts what "authority" means in §9.1.
- **Merge conflicting packs with last-write-wins and log a warning.** Rejected outright: §9.2
  names this as the behaviour to avoid.
- **Have the resolver throw on conflict.** Rejected: conflicts are information an operator needs
  rendered, and several may exist at once — an exception carries one and aborts the rest.
