# Releasing Aldus

Ordered, checkable, and written to be followed under pressure. Decisions are recorded in
[ADR-0020](adr/0020-versioning-and-release-policy.md) (versioning) and
[ADR-0022](adr/0022-release-pipeline-and-trusted-publishing.md) (pipeline).

**The rules that do not bend:**

- Every public package shares one version. Lockstep, no exceptions.
- Internal dependencies are exact pins, never ranges.
- The first release of a version goes to `next`. **Nothing reaches `latest` without the owner's
  approval after adopter smoke tests.**
- `@aldus-runtime/e2e` is never published.
- **Publishing is irreversible.** npm forbids unpublishing after 72 hours, and unpublishing
  inside 72 hours breaks anyone who already installed. Assume you cannot take it back.

---

## One-time owner setup

Do this once, before the first release. It is an npm account action; no script performs it.

### 1. Confirm the organisation and ownership

```bash
npm whoami
npm org ls aldus-runtime
```

You must be an owner of `aldus-runtime`. If `npm whoami` fails, `npm login` first.

### 2. Configure a trusted publisher for each package

Trusted publishing exchanges a GitHub OIDC token for short-lived credentials, so no npm
automation token is ever stored in the repository.

For **each** of the twelve public packages, on npmjs.com:

1. Open `https://www.npmjs.com/package/<name>/access` — for a package that does not exist yet,
   this is configured after its first publish, so the first release uses a granular token (below)
   and every subsequent one uses OIDC.
2. Under **Trusted Publisher**, choose **GitHub Actions** and enter:
   - Organisation or user: `jamchen`
   - Repository: `aldus`
   - Workflow filename: `release.yml`
   - Environment: `npm-publish`
3. Save.

> **First release only.** npm cannot attach a trusted publisher to a package that does not exist.
> Either create a granular access token scoped to the `@aldus-runtime` scope with _Read and
> write_ for the first publish and delete it immediately afterwards, or publish the first version
> from your own machine with `npm publish --tag next --access public` per package. Configure
> trusted publishing straight after, and confirm no token remains in repository secrets.

### 3. Create the `npm-publish` GitHub Environment

`Settings → Environments → New environment → npm-publish`

- Add **yourself** as a required reviewer. This is what makes the publish gate a platform
  control rather than a convention.
- Restrict deployment branches and tags to `v*`.

Without this environment the publish job cannot run at all.

---

## Cutting a release

### Step 1 — the tree is clean and green

```bash
git switch main && git pull
npm ci
npm run verify
```

All of format, build, test-typecheck, schema drift, and tests must pass. Do not continue past a
failure by rerunning it.

### Step 2 — the publish set is what you expect

```bash
node scripts/publish-set.mjs
```

Confirm: **12 packages listed, `@aldus-runtime/e2e` under "Never published"**. If `e2e` appears
in the publish set, stop — something has edited `NEVER_PUBLISH` in `scripts/publish-set.mjs`.

### Step 3 — set the version

Lockstep across every package including the root, and internal pins to the same exact version.

Set it once and use it for the rest of this document. Every later step reads `${VERSION}` rather
than naming a release, so this procedure cannot describe the version it was written during — the
mistake ADR-0031 exists to prevent, and one this file had already made.

```bash
VERSION=0.2.0-next.4   # the release you are cutting
npm version "${VERSION}" --workspaces --include-workspace-root --no-git-tag-version
```

### The stale-pin window, and why it reaches CI

`npm version` runs an install as it goes, and at that moment the workspaces carry the new version
while their internal pins still carry the old one. npm resolves the mismatch the only way it can —
by fetching the **previous release** from the registry into `packages/*/node_modules`.

**This is written into `package-lock.json`, so it is not a local-only problem.** Committing that
lockfile makes `npm ci` reproduce the same nested copies on a clean CI checkout, and the build
fails with type errors naming two different `FileWorkspace`s or `GateEngine`s — one from the
workspace, one from a registry copy of the previous release. This document previously claimed CI
was unaffected. It is not; a release was tagged and failed exactly this way.

Deleting the directories is not enough, because the next install restores them from the lock. After
updating the pins, regenerate the lockfile from nothing:

```bash
rm -rf node_modules packages/*/node_modules packages/*/dist packages/*/*.tsbuildinfo package-lock.json
npm install
```

Then confirm the lock is clean before committing — this must print `0`:

```bash
node -e "const l=require('./package-lock.json');console.log(Object.keys(l.packages).filter(k=>k.includes('packages/aldus-')&&k.includes('node_modules/@aldus-runtime')).length)"
```

Then update every internal dependency to the exact version. Verify:

```bash
node scripts/publish-set.mjs --strict
```

This exits non-zero until versions are lockstep, `private` is cleared, `publishConfig.access` is
`public`, `LICENSE` and `NOTICE` are in `files[]`, and every internal dependency is an exact pin.
Read what it prints; it names each problem.

### Step 4 — the version does not already exist

```bash
npm view "@aldus-runtime/core@${VERSION}" version
```

An error here is what you want — it means the version is free. **If it prints a version, stop.**
That version is taken and cannot be reused; pick the next one.

### Step 5 — inspect the tarballs

```bash
node scripts/pack.mjs --out /tmp/aldus-release
tar -tzf "/tmp/aldus-release/aldus-runtime-core-${VERSION}.tgz" | head -30
```

Check by eye: `package/LICENSE`, `package/NOTICE`, `package/dist/`, nothing from `src/`, no
fixtures you did not intend, no secrets.

### Step 6 — the clean-consumer gate

```bash
node scripts/clean-consumer.mjs
```

This is the release gate. It packs, installs into a project outside the monorepo, proves nothing
resolves back into the repository, typechecks a consumer against the published declarations, runs
the composed smoke flow, installs each package alone to prove it declares what it imports, and
runs the `aldus` binary. **A failure here is a release blocker, not a warning.**

### Step 7 — release notes

Write them before publishing, while you still remember what changed. Cover: what is new, what
changed in a public API, known limitations with issue numbers, and the fact that this is a `next`
release not yet promoted to `latest`.

### Step 8 — commit, tag, push

```bash
git add -A
git commit -m "release: ${VERSION}"
git tag "v${VERSION}"
git push origin main --follow-tags
```

The tag must match the manifests exactly; the workflow refuses the run otherwise.

### Step 9 — approve the publish

Pushing the tag starts `Release`. It verifies, gates, packs, and uploads the tarballs as a
workflow artifact, then **waits** on the `npm-publish` environment.

Download the tarball artifact and inspect it before approving. Once you approve, publishing
happens and cannot be undone.

The workflow publishes with `--tag next --access public --provenance`. **It never assigns
`latest`.**

### Step 10 — verify what landed

```bash
npm view @aldus-runtime/core dist-tags
```

Expect `next` to be `${VERSION}`, and **`latest` to be unchanged** — it stays wherever the last
deliberate promotion left it (ADR-0023). Compare it against the snapshot the workflow took, not
against a value remembered from a previous release: `latest` moving is a release failure unless
you are promoting on purpose. Then, in a scratch directory outside the repository:

```bash
mkdir /tmp/aldus-check && cd /tmp/aldus-check && npm init -y
npm i @aldus-runtime/cli@next
npx aldus --help
```

Check the package page shows the Apache-2.0 licence, the repository link, and the provenance
badge.

---

## Promoting to `latest`

**Only after** the clean-consumer gate and a real adopter smoke test pass, and the owner approves.

```bash
for pkg in artifact-registry cli core file-store gate-engine mcp regression release services stage-runner testkit tts-ledger; do
  npm dist-tag add "@aldus-runtime/${pkg}@${VERSION}" latest
done
```

Then confirm every package moved:

```bash
for pkg in artifact-registry cli core file-store gate-engine mcp regression release services stage-runner testkit tts-ledger; do
  echo "${pkg}: $(npm view "@aldus-runtime/${pkg}" dist-tags.latest)"
done
```

A partial promotion is worse than none — a consumer installing `latest` would get a mixed
composition, which is exactly what lockstep exists to prevent.

---

## When a bad version is already published

Do not reach for `npm unpublish`. It is unavailable after 72 hours, and within 72 hours it breaks
every install that already succeeded — including lockfiles in other people's CI.

**The order is: stop the bleeding, then fix forward.**

### 1. Stop it becoming the default

If the bad version reached `latest`, move `latest` back to the last good version immediately:

```bash
npm dist-tag add "@aldus-runtime/<pkg>@<last-good>" latest
```

Do this for **every** package, not just the broken one.

### 2. Deprecate the bad version

```bash
npm deprecate "@aldus-runtime/<pkg>@<broken-version>" \
  "Broken: <one line on what breaks>. Use <fixed-version> or later."
```

Anyone installing it now sees the warning. Deprecate every package at that version if the
composition is what broke — a consumer cannot tell which one was at fault.

### 3. Fix forward

Patch, run the whole procedure again at the next patch version, and publish to `next` first even
if the fix looks trivial. A hurried second release is how a bad release becomes two.

### 4. Write down what the gate missed

If a defect reached the registry, the clean-consumer gate did not catch it. Add the case to
`scripts/consumer-fixture/smoke.mjs` in the same change as the fix, so the next release cannot
repeat it.

---

## Version and tag policy

Read this before choosing a version number. It is the part that is easy to get wrong, and the
`0.1.0` bootstrap got it wrong (ADR-0023).

| Situation                               | Version                           | Tag                  | Reaches `latest`?                               |
| --------------------------------------- | --------------------------------- | -------------------- | ----------------------------------------------- |
| Not validated by an adopter             | `0.2.0-next.0`, `0.2.0-next.1`, … | `next`               | No — npm does not move `latest` to a prerelease |
| Validated by an adopter, owner approves | `0.2.0`                           | `next`, then promote | Yes, deliberately                               |
| `0.1.0` bootstrap                       | `0.1.0`                           | both                 | Yes — a documented exception                    |

**`--tag next` alone does not keep a release off `latest`.** npm assigns `latest` on a package's
_first_ publish regardless of the flag, because a package must have one. That is exactly how
`0.1.0` ended up on `latest` despite every publish specifying `--tag next`. For every package
that already exists the flag behaves as expected — but a rule that only holds from the second
publish onwards is not one to rely on, which is why unvalidated releases use a prerelease
_version_ instead. The registry enforces that; a flag's behaviour depends on state.

The release workflow snapshots `latest` and `next` for all twelve packages before publishing,
asserts afterwards, and fails if `latest` moved. A deliberate promotion passes
`allow-latest-move` on `workflow_dispatch`, so the intent is stated rather than inferred.

Promoting to `latest` later, once an adopter has validated:

```bash
npm dist-tag add @aldus-runtime/<name>@<version> latest   # per package, all twelve
```

## Who may release what

Recorded because a standing authorization that lives only in a conversation is one context loss
away from being forgotten or overstepped.

| Action                             | Authority                                               | Enforced by                                                        |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Prerelease `0.2.0-next.N` → `next` | **standing**, granted 2026-08-18 — publish, then report | the `npm-publish` environment reviewer                             |
| Any non-prerelease version         | the owner, per release                                  | same                                                               |
| Promoting anything to `latest`     | **the owner, always**                                   | not automatable; `--allow-latest-move` must be passed deliberately |
| Changing this table                | the owner                                               | —                                                                  |

The scope is deliberately narrow. A prerelease on the `next` tag is irreversible — npm unpublish
is unavailable after 72 hours — but its blast radius is bounded: nothing installs `next` by
default, so the population exposed to a bad prerelease is people who opted in and are watching.
`latest` changes what every future `npm install` resolves, which is a different kind of act and
stays a human decision.

The GitHub environment still requires a reviewer for every publish, including prereleases. That is
not redundant with the standing authorization: the authorization says _what may be released
without asking_, and the environment gate is what makes any release auditable and attributable at
all. Removing it would make the publish path unobservable, which is a separate loss from who
decides.

## Known considerations

Both items previously listed here were resolved before the first release. They are kept as
notes because each is a rule a future package must follow.

- **A package whose public declarations reference Node globals declares `@types/node` as a
  runtime dependency.** Three do — `core` (`Headers`, in `redactHeaders`), `services` and
  `stage-runner` (`AbortSignal`, on stage cancellation). Without the declaration a consumer meets
  the requirement as an error inside _our_ `.d.ts` files rather than through their own install.
  The clean-consumer fixture deliberately does **not** install `@types/node`, so the typecheck
  only passes while the packages declare what their declarations need. Adding a Node global to a
  public type without adding the dependency will fail the gate.
- **`src` ships, so source maps resolve.** `dist/*.map` reference `../src/*.ts`; without the
  sources the maps point at nothing and "go to definition" lands nowhere. Shipping source also
  suits a contracts-heavy library under Apache-2.0, where the source is public regardless. The
  cost is roughly doubled tarball size, which is small in absolute terms.
