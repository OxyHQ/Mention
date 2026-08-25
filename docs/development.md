# Development

Commands, dependency management, worktrees, and build/test gotchas for
working in this repository day to day. Coverage policy specifically:
`packages/frontend/docs/TESTING-POLICY.md`.

## Commands

```bash
bun run dev / dev:frontend / dev:backend / dev:mcp / dev:mcp:http
bun run build            # shared-types + backend + mcp
bun run test / lint / check / clean
```

- **Run backend tests from the package root** (`cd packages/backend && bun run test`) — from the repo root they pick up stale `.dist` copies and report false failures.
- **Rebuild `shared-types` before believing a red typecheck or build.** It is consumed through its BUILT `dist`, so after a rebase every other package compiles against the previous build and reports newly-landed symbols as missing (`TS2305`) in files you never touched.
- **A `doctor` failure SIGINTs the rest of `check:workspace`** — the killed siblings are not broken and which ones die varies per run. Re-run the survivors individually (`validate:workflows`, `validate:lockfile`, `validate:i18n`, `validate:logger`, `audit:security`) before believing any of them failed.
- **The backend and MCP run on Bun, not Node**, typed `["node","bun"]`; `@types/bun` is catalogued at the exact `packageManager` version and doctor fails on drift. The frontend stays Node-typed.
- **Do not try to replace a dependency with a Bun built-in here.** `Bun.YAML` loses duplicate-key detection (breaks `scripts/validate-workflows.mjs`). `Bun.redis` has no `multi`/`exec`/`watch`. `Bun.Image` is not reachable from `expo prebuild`'s Node. `bun test` replaces neither Vitest (backend) nor Jest (frontend). The global virtual store is unreachable under `linker = "hoisted"`, which Metro requires.
- **`bun run test` computes no coverage.** CI runs `test:coverage` + `coverage:check` against `packages/frontend/coverage-policy.json` (per-file pins, a no-regression ratchet). After genuinely raising coverage, run `coverage:record` and commit `coverage-baseline.json`. Detail: `packages/frontend/docs/TESTING-POLICY.md`.

## Bumping an Oxy SDK package (`bun add` reports success and changes nothing)

- **Shared versions live ONLY in `workspaces.catalog` in the root `package.json`.** A bump is one catalog edit plus `bun install`. Manifests and the root `overrides` name the package as `"catalog:"`.
- **`bun add`/`bun update` are the wrong tools** — an override beats a workspace range, so they print success and leave the old version in `node_modules` and `bun.lock`. Doctor rejects a manifest or override re-pinning a catalogued package to a literal range, and rejects `@oxyhq/bloom` in the root `dependencies`.
- Packages with a single consumer and an exact pin (`@oxyhq/crowdsource*`, `@oxyhq/federation`, `@oxyhq/protocol`) are deliberately NOT catalogued.
- **After bumping, check no NESTED copy of the old version survived** — an incremental install preserves a recorded edge by nesting it, and every gate stays green while a dependent loads the old major. `grep -oE '"[^"]*<pkg>": \["<pkg>@[0-9.]+' bun.lock | sort -u` must print exactly one line; delete the stale nested keys and reinstall rather than regenerating the lockfile.
- `bun update` also writes touched packages into the ROOT `dependencies` — check `git diff package.json` after running it.
- **Assert the installed version after any bump** (`node -e "…/package.json').version"`) before running any gate.
- **Do NOT regenerate `bun.lock` from scratch.** `.github/scripts/verify-lockfile.sh origin/main` prints the minimal correct delta, and compares the COMMITTED lockfile.
- `validate:lockfile` check 4 is the only gate that catches a catalogued bump landing a major its dependents reject; deliberate cases live in `ACCEPTED_OVERRIDE_RANGE_VIOLATIONS`.

## This checkout: worktrees and stub servers

- **Never `git stash` here.** ~70 linked worktrees share one repository stash stack, a committed worktree stashes nothing (exit 0, no entry), and `pop` then takes another session's work into your tree. Compare against another commit with a separate detached worktree or `git show <commit>:<path>`. If it happened: a CONFLICTED pop does not drop the entry — restore your files, then VERIFY the entry survived.
- **A stub server must bind a RANDOM high port** — never `4110`, which every frontend dev server here targets — and its teardown must be VERIFIED (`pgrep -f`, `ss -ltnp`), never trusted to `pkill`'s exit status.

## CodeQL

A finding on your PR reports what the DIFF introduces, not what the repo accepts — **count the same rule on `main` first** (`gh api --paginate repos/OxyHQ/Mention/code-scanning/alerts`). Convention: a route-level limiter for feeds, expensive aggregations and spam-surface writes; plain CRUD rides the app-wide `createOxyRateLimit` (a closure in `app.ts`), which the query cannot see.

- **`router.use(...limiters)` with an empty array throws at import.** The `isProduction ? [x] : []` idiom is only safe in the PER-ROUTE position — which is also the only position CodeQL inspects.
- **`rateLimitPrefixUniqueness.test.ts` resolves prefixes by reading SOURCE**, so write each `RedisStore` prefix as a literal, never through a factory.

## One-shot scripts

**Scripts in `src/scripts/` MUST close every resource they opened and
`process.exit()`** (`closeAdminScriptResources()` in
`scripts/lib/adminScriptLifecycle.ts`), or the Fargate one-shot task runs
forever.

## Local Android release APK

```bash
cd packages/frontend/android
NODE_ENV=production ./gradlew :app:assembleRelease -x lintVitalRelease \
  -PreactNativeArchitectures=arm64-v8a -Dorg.gradle.jvmargs="-Xmx8g -XX:MaxMetaspaceSize=1g"
```

- **`NODE_ENV=production` is REQUIRED** or `export:embed` aborts and the APK ships with NO embedded bundle (verify: `unzip -l app-release.apk | grep index.android.bundle`).
- Build arm64-only; the multi-ABI build fails at the x86 CMake task.
- **Metro dev builds must run from `packages/frontend`**, not the repo root — from the root Expo resolves the legacy `expo/AppEntry` and returns HTTP 500.
