# ADR-0042: Promotion to `latest` stays interactive, and no bypass token enters CI

- Status: Accepted
- Date: 2026-08-20
- Relates to: §19.2 Security, ADR-0020, ADR-0022, ADR-0023
- Supersedes nothing; revisit is scheduled below

## Context

Moving `latest` costs **twelve interactive authentications**, one per public package, because npm
requires a one-time password for every publish-class operation and `npm dist-tag add` is one. The
first promotion since `0.1.0` was performed this way and the cost was raised as a real problem:
_"it really troubles me if every release I should do the same thing."_

That is a fair complaint about a procedure, and it deserved measurement rather than a shrug.

### What was measured

`Release` publishes with **no stored credential at all** — OIDC trusted publishing, exchanged for
short-lived rights — so the obvious question was whether promotion could run the same way. A spike
workflow with `id-token: write`, npm at latest, and the publish job's `setup-node` configuration
answered it:

```
npm error code E401
npm error Unable to authenticate, your authentication token seems to be invalid.
```

**Not a refused permission — no credential at all.** npm's OIDC exchange happens inside
`npm publish`; it is not a login other commands inherit, and `dist-tag` is not covered. The probe
touched a throwaway tag on an already-published version and was deleted afterwards.

### What was researched, and what it changed

The reviewing engineer — me — then suggested a **short-lived granular access token, minted per
release and revoked after**, as the option worth reconsidering first. Reading npm's actual policy
made that suggestion worse than it sounded, in three ways:

1. **Minting is itself an interactive 2FA challenge.** Since 31 July 2026, creating or deleting
   tokens cannot be done by a bypass token. So "mint, use, revoke" costs two interactive
   authentications, not zero. The saving is twelve to two, not twelve to none.
2. **There is an announced sunset.** Targeted January 2027, 2FA-bypass tokens lose direct
   publishing capability entirely, retaining only private reads and staging publishes a maintainer
   approves with 2FA. `dist-tag` is a publish-class operation and almost certainly falls under it.
   Building the promotion path on this buys a migration whose destination — OIDC — is what the
   spike just measured as not covering `dist-tag`.
3. **Nobody can confirm it works without minting one.** npm's documentation says bypass applies to
   "package and automation actions such as publishing" and does not enumerate `dist-tag`. Settling
   it requires an account action.

Staged publishing, GitHub's other recommendation, does not help either: `npm stage approve`
requires interactive authentication and cannot be satisfied by OIDC or granular tokens. It is the
same shape, relocated.

## Decision

**Promotion to `latest` remains a manual, interactive operation, and no 2FA-bypass token —
long-lived or short — is placed in CI.**

`scripts/promote-latest.mjs` is the supported path: it refuses without a TTY, authenticates once
per package, verifies every tag against the registry afterwards with retries, and on a partial
promotion prints the remaining commands rather than only the diagnosis.

### The reframing that makes the cost proportionate

**Prereleases cost zero interactive authentications.** The release pipeline is fully OIDC;
nineteen prereleases were published without a single prompt. Only _promotion_ costs twelve, and
promotion is rare by design — ADR-0023 exists precisely to keep `latest` from moving on every
release.

The pain was felt because nineteen prereleases and one promotion happened in a single day. Twelve
authentications a handful of times a year is a different proposition from twelve per release, and
the procedure is already optimised for the frequent case.

### What would have to be true to revisit

- npm extends OIDC trusted publishing to cover `dist-tag`; or
- the January 2027 change lands and forces a different mechanism anyway; or
- the promotion frequency rises far enough that twelve authentications stops being rare.

**The January 2027 date is a scheduled revisit, not a hypothetical.** Whatever replaces bypass
tokens will need evaluating for this path regardless of what is decided today.

## Consequences

- Promotion cannot be automated, and cannot be delegated to CI. That is the price of having no
  long-lived publishing credential anywhere in the system, and it is a price this project has
  already chosen twice (ADR-0022, and the owner's standing instruction that no bootstrap token
  enters GitHub Actions).
- Promotion cannot happen while the owner is away from a browser. Given ADR-0023 makes promotion
  an owner decision requiring adopter smoke tests, an operation that _requires_ the owner present
  is not a new constraint — it makes an existing one physical.
- A future maintainer meeting twelve prompts will assume nobody looked. `RELEASING.md` records the
  measurement and names the probe to repeat, so the dead end is documented rather than rediscovered.

## Alternatives considered

- **A granular access token in Actions secrets, scoped to the twelve packages.** Rejected: it is a
  credential that can move `latest` on every package for as long as it lives, which is the attack
  the July 2026 restriction exists to blunt, and it expires as a mechanism in about five months.
  If it were ever adopted, the safeguard must be **the shortest expiry npm allows rather than a
  manual revoke** — a forgotten revocation leaves a bypass token alive indefinitely, whereas an
  expiry fails closed.
- **One OTP reused across all twelve commands via `--otp`.** Rejected: it places the code in shell
  history, a script, or an environment variable, against a standing instruction that a one-time
  password is never stored or pasted.
- **Publishing with `--tag latest` at release time.** Works under OIDC, and rejected as the most
  expensive option despite being the cheapest to build: it moves the promotion decision _before_
  the release, so `latest` would advance without the adopter smoke test ADR-0023 requires. The
  mechanism would be free and the governance would be gone.
- **Reducing the package count.** Not considered seriously; lockstep across twelve packages is
  ADR-0020's, and the publish set is what it is.

## Sources

- [Restricting npm bypass-2FA granular access tokens](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)
- [Staged publishing and new install-time controls for npm](https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm/)
- [About access tokens — npm Docs](https://docs.npmjs.com/about-access-tokens)
- [Trusted publishing for npm packages — npm Docs](https://docs.npmjs.com/trusted-publishers/)
