# Dependencies, lockfiles and the CI gates

> Moved out of `AGENTS.md` unchanged. The one-line rules stay there.

## Bumping an Oxy SDK package (`bun add` reports success and changes nothing)

- **Shared versions live ONLY in `workspaces.catalog` in the root `package.json`.** A bump is one catalog edit plus `bun install`. Manifests and the root `overrides` name the package as `"catalog:"`.
- **`bun add`/`bun update` are the wrong tools** — an override beats a workspace range, so they print success and leave the old version in `node_modules` and `bun.lock`. Doctor rejects a manifest or override re-pinning a catalogued package to a literal range, and rejects `@oxyhq/bloom` in the root `dependencies`.
- Packages with a single consumer and an exact pin (`@oxyhq/crowdsource*`, `@oxyhq/federation`, `@oxyhq/protocol`) are deliberately NOT catalogued.
- **After bumping, check no NESTED copy of the old version survived** — an incremental install preserves a recorded edge by nesting it, and every gate stays green while a dependent loads the old major. `grep -oE '"[^"]*<pkg>": \["<pkg>@[0-9.]+' bun.lock | sort -u` must print exactly one line; delete the stale nested keys and reinstall rather than regenerating the lockfile.
- `bun update` also writes touched packages into the ROOT `dependencies` — check `git diff package.json` after running it.
- **Assert the installed version after any bump** (`node -e "…/package.json').version"`) before running any gate.
- **Do NOT regenerate `bun.lock` from scratch.** `.github/scripts/verify-lockfile.sh origin/main` prints the minimal correct delta, and compares the COMMITTED lockfile.
- `validate:lockfile` check 4 is the only gate that catches a catalogued bump landing a major its dependents reject; deliberate cases live in `ACCEPTED_OVERRIDE_RANGE_VIOLATIONS`.

## CodeQL

A finding on your PR reports what the DIFF introduces, not what the repo accepts — **count the same rule on `main` first** (`gh api --paginate repos/OxyHQ/Mention/code-scanning/alerts`). Convention: a route-level limiter for feeds, expensive aggregations and spam-surface writes; plain CRUD rides the app-wide `createOxyRateLimit` (a closure in `app.ts`), which the query cannot see.

- **`router.use(...limiters)` with an empty array throws at import.** The `isProduction ? [x] : []` idiom is only safe in the PER-ROUTE position — which is also the only position CodeQL inspects.
- **`rateLimitPrefixUniqueness.test.ts` resolves prefixes by reading SOURCE**, so write each `RedisStore` prefix as a literal, never through a factory.


## Install, test-runner and coverage caveats

> Moved out of `AGENTS.md` unchanged.

- **`bun install` refuses to RESOLVE a dependency published in the last week** (`minimumReleaseAge`). Never affects `--frozen-lockfile`. Any step that RE-RESOLVES must pass `--minimum-release-age=0` (`.github/scripts/verify-lockfile.sh` does). First-party packages are excluded by EXACT name — a scope glob parses and matches nothing, so a new first-party dependency must be added to `minimumReleaseAgeExcludes`. A warm manifest cache hides this; verify against CI or a cold cache.
- **Do not try to replace a dependency with a Bun built-in here.** `Bun.YAML` loses duplicate-key detection (breaks `scripts/validate-workflows.mjs`). `Bun.redis` has no `multi`/`exec`/`watch`. `Bun.Image` is not reachable from `expo prebuild`'s Node. `bun test` replaces neither Vitest (backend) nor Jest (frontend). The global virtual store is unreachable under `linker = "hoisted"`, which Metro requires.
- **`bun run test` computes no coverage.** CI runs `test:coverage` + `coverage:check` against `packages/frontend/coverage-policy.json` (per-file pins, a no-regression ratchet). After genuinely raising coverage, run `coverage:record` and commit `coverage-baseline.json`. **`jest-expo` resolves the NATIVE platform extension** — a bare relative import never loads a sibling `.web` fork, so a broken web-only fork can vanish from the coverage denominator and the overall percentage moves the reassuring way. The only honest signal is the file's ABSENCE from the report, which is what the policy asserts.
