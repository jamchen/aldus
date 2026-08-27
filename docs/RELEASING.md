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

- **Deployment branches and tags: add `main` as a _branch_ policy.** Keep `v*` as a _tag_ policy
  only if you still tag releases for other reasons — the workflow no longer publishes from a tag
  (ADR-0050).
- **No required reviewer.** ADR-0050 removed it deliberately, and this document told you to add
  one for four days after that stopped being true.

Without this environment the publish job cannot run at all.

> **This section previously said to add yourself as a required reviewer and to restrict
> deployments to `v*`.** Both were correct before ADR-0050 and wrong after it, and following them
> would rebuild the exact failure this repository shipped for four days: the environment admitted
> only _tag_ deployments while the workflow triggered on a `main` push, so the publish job was
> skipped on every merge — eleven consecutive green Release runs in which the publish path never
> executed once. Verified after the fix: `1b4c428` and `6d6ce9f` both show
> `publish to npm (next) — success`.
>
> A runbook that teaches a topology the pipeline no longer has is worse than a stale one, because
> someone follows it.

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

Check by eye: `package/LICENSE`, `package/NOTICE`, `package/dist/`, `package/src/`, no fixtures you
did not intend, no secrets.

> **`src/` belongs in the tarball.** This line previously said "nothing from `src/`", which
> contradicted the rationale further down this same file — _"`src` ships, so source maps resolve"_
> — and every package's `files` list, which names `src` deliberately. A releaser following the
> checklist would have rejected the artifact the repository is built to produce. Two statements of
> one policy in one document, and only one of them was true.
>
> What to actually look for: `src/` carries the TypeScript the maps in `dist/*.map` reference, and
> nothing else. A stray fixture or scratch file under `src/` ships too.

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

### Step 8 — open a pull request

**`main` is protected and you cannot push to it.** `enforce_admins` is on, so this holds for the
owner too. The bump goes in a pull request like any other change.

```bash
git add -A
git commit -m "release: ${VERSION}"
git push -u origin "release/${VERSION}"
gh pr create --title "release: ${VERSION}"
```

Say in the PR body that merging **will publish**.

**An ordinary `next` release does not need a fresh owner answer.** The owner ruling on
[#247](https://github.com/jamchen/aldus/issues/247) grants standing authorization for the successful
`next` path, _including the merge that triggers it_, when all five of these hold:

1. the PR passed the required review and branch-protection gates;
2. the workflow publishes only the expected prerelease version to `next`;
3. the publish set comes from `publish-set.mjs` and is **verified in full** — every package in it,
   not the ones you happen to list;
4. the **publish job's own conclusion** is read; a green merge is not proof of publication;
5. registry verification confirms the intended packages and versions, installs them from npm,
   **exercises the changed surface**, and confirms `latest` did not move.

Step 5 is not ceremony, and one release proved it: a prerelease shipped a new CLI verb whose
dispatch made it refuse every invocation. The publish job was green, every package in the set was at
the right version, and `latest` had not moved — **the first four checks passed on a command that
could not run**, and only installing it and running it found that.

This supersedes the requirement that previously stood here for an interactive owner authorization on
every release-bearing merge. That requirement's reasoning — every agent session authenticates as
`jamchen`, so an `OWNER RULING` marker cannot by itself prove who typed it — is unchanged and still
why the reserved decisions below stay per-instance.

**Reserved to the owner, per instance, and never inferred from this standing authorization:**
promotion or movement of `latest`; recovery after a partial publish or registry inconsistency;
publishing outside this workflow or publish set; paid execution or budget changes; package deletion
or unpublish; repository or package visibility changes; credential, trusted-publisher or other
security-setting changes; legal or licensing decisions.

**A partial publish is a reserved decision, not a retry.** If the set is inconsistent, stop and ask.

Tagging is optional and **publishes nothing**. Before ADR-0050 a tag push was the release trigger;
it is not one now.

### Step 9 — the merge is the publish

Merging the PR starts `Release`. It verifies, gates, packs, uploads the tarballs as a workflow
artifact, and then **publishes without waiting for anyone** — the reviewed merge _is_ the
authorization (ADR-0050). There is no approval step and no second chance to inspect.

So inspect **before** merging — and **the tarballs are not on the PR's CI run.** `Pack for
inspection` and `Upload tarballs` exist only in the Release workflow, which runs _after_ the merge.
The bytes you inspect are the ones you packed locally in Step 5, and that step is not optional for
a release-bearing merge.

If PR-attached artifacts would be better, that is a separate non-publishing change to `ci.yml`.
Until it exists, do not go looking for an artifact that is not produced.

The workflow publishes with `--tag next --access public --provenance`. **It never assigns
`latest`.**

> **Read the `publish to npm (next)` job's own conclusion, never the run's.** A run whose publish
> job was _skipped_ still reports `success`, and did so eleven times in a row while the path was
> broken. `gh run view <id> --json jobs` is the answer; the green tick beside the run is not.

### Step 10 — verify what landed

```bash
npm view @aldus-runtime/core dist-tags
```

**`dist-tags`, not `version`.** `npm view <pkg> version` returns whatever `latest` points at, so
against a prerelease line it reports the _previous_ release and reads as "the publish did not
land". The tell is that every package shows the same number as `latest`.

Check the **whole set**, not one package. A publish that fails partway leaves some packages at the
new version and some not, and that cannot be undone — a republish of the ones that landed is
refused by design. Know which succeeded before deciding anything, and treat a partial publish as
the owner's call rather than a retry.

Expect `next` to be `${VERSION}`, and **`latest` to be unchanged** — it stays wherever the last
deliberate promotion left it (ADR-0023). Compare it against the snapshot the workflow took, not
against a value remembered from a previous release: `latest` moving is a release failure unless
you are promoting on purpose. Then, in a scratch directory outside the repository:

```bash
mkdir /tmp/aldus-check && cd /tmp/aldus-check && npm init -y
npm i @aldus-runtime/cli@next
npx aldus --help
```

**Then exercise the thing this release changed**, not only that the binary starts. `dist-tags` says
a version exists; only an install that runs the change says the change is in it, and a green
publish job says neither. This is the last point at which a wrong artifact is still cheap to find.

Check the package page shows the Apache-2.0 licence, the repository link, and the provenance
badge.

---

## Promoting to `latest`

**Only after** the clean-consumer gate and a real adopter smoke test pass, and the owner approves.

```bash
node scripts/promote-latest.mjs "${VERSION}"
```

**Run it from a real terminal, not from an editor or an agent session.** npm requires a one-time
password for every publish-class operation and `dist-tag add` is one, so with no TTY it cannot
prompt and fails on the first package. The script detects that and refuses up front rather than
letting you discover it halfway through.

Expect npm to ask you to authenticate **once per package**.

### Why it is once per package, and why that stands

This was measured rather than assumed. The `Release` workflow publishes with no stored credential
at all — OIDC trusted publishing, exchanged for short-lived rights — so the obvious question is
whether promotion could run the same way and cost one environment approval instead of twelve
authentications.

It cannot. A workflow with `id-token: write`, npm at latest, and the same `setup-node` registry
configuration fails `npm dist-tag add` with:

```
npm error code E401
npm error Unable to authenticate, your authentication token seems to be invalid.
```

Not a permission refusal — **no credential at all**. npm's OIDC exchange happens inside
`npm publish`; it is not a login that other commands inherit, and `dist-tag` is not covered.

So the remaining ways to avoid twelve authentications all trade away something this project has
decided to keep:

- **An automation or granular token in Actions.** Ruled out: it is a long-lived credential in CI,
  and npm is restricting tokens that bypass 2FA regardless.
- **One OTP reused across all twelve commands via `--otp`.** Puts the code in shell history, a
  script, or an environment variable. Ruled out.
- **Publishing with `--tag latest` at release time.** Supported by OIDC, and it inverts the
  governance: promotion would have to be decided _before_ the release rather than after adopter
  smoke tests, which is the decision ADR-0023 exists to keep separate.

Twelve authentications is therefore the floor for the current design, and it is the price of
having no long-lived publishing credential anywhere. Do not re-investigate without new information
from npm — the probe above is what to repeat.

Recorded as [ADR-0042](adr/0042-promotion-stays-interactive.md), including the sunset date that
schedules the next look: 2FA-bypass tokens are targeted to lose direct publishing capability in
**January 2027**, which forces this question back open whatever is decided now.

The script verifies every package against the registry afterwards and retries the read: `npm view`
serves a cached path that lags a write by seconds, and checking immediately reports a healthy
release as a partial failure — which is exactly what happened the first time `latest` moved.

A partial promotion is worse than none. Internal dependencies are exact pins, so a `latest` where
`cli` is one version and `core` another is not a degraded install but a broken one. If the script
reports a split, **finish rather than stop** — it prints the remaining commands, and re-running is
idempotent.

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
