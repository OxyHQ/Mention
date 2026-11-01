# Development

Commands, dependency management, worktrees, and build/test gotchas for
working in this repository day to day. Coverage policy specifically:
`packages/frontend/docs/TESTING-POLICY.md`.

## Commands

```bash
bun run dev / dev:frontend / dev:backend / dev:mcp / dev:mcp:http
bun run build            # shared-types + backend + mcp
bun run test / lint / check / clean
bun run lint:fix / format   # Biome
```

- **Biome formats and lints every package** (`biome.jsonc` at the root, run in CI as `bunx biome ci .`). `packages/frontend/eslint.config.js` is a deliberately minimal ESLint run by `expo lint .` over the whole frontend: only the Expo env-var rules, the React Compiler diagnostics and a few `eslint-plugin-react` checks Biome has no equivalent for. The frontend's import guards (the `@oxy.so/bloom/icons` barrel, `@expo/vector-icons`, expo-video's `VideoView`) are Biome `noRestrictedImports` overrides. Suppress with `// biome-ignore lint/<group>/<rule>: <reason>`.

- **Run backend tests from the package root** (`cd packages/backend && bun run test`) — from the repo root they pick up stale `.dist` copies and report false failures.
- **The backend suite is moving from Vitest to `bun test`, a batch at a time.** A `*.test.ts` that imports from `'bun:test'` is run by `bun test` (`bun run test:bun`, via `packages/backend/runBunTests.ts`) and excluded from Vitest (`bun run test:vitest`); `packages/backend/testRunnerSplit.ts` is the one rule both read, and `bun run test` runs both. Pass a file filter to the runner that owns the file — an argument appended to `bun run test` lands on `test:bun` only. In a migrated file, `vi.mock` becomes `mock.module`, which is NOT hoisted: register it before importing the module under test (dynamic `import()` after it). `packages/backend/src/__tests__/bunSetup.ts` is `setup.ts`'s counterpart (the same Redis/logger/pino mocks); files needing a private database (`packages/backend/src/__tests__/isolatedDatabaseFiles.ts`) stay on Vitest until it ports that block. Coverage floors are still judged on the Vitest half only.
- **Rebuild `shared-types` before believing a red typecheck or build.** It is consumed through its BUILT `dist`, so after a rebase every other package compiles against the previous build and reports newly-landed symbols as missing (`TS2305`) in files you never touched.
- **A `doctor` failure SIGINTs the rest of `check:workspace`** — the killed siblings are not broken and which ones die varies per run. Re-run the survivors individually (`validate:workflows`, `validate:lockfile`, `validate:i18n`, `validate:logger`, `audit:security`) before believing any of them failed.
- **The backend and MCP run on Bun, not Node**, typed `["node","bun"]`; `@types/bun` is catalogued at an exact version on `packageManager`'s major.minor, no newer than it (DefinitelyTyped trails Bun releases), and doctor fails on drift. Every `FROM oven/bun:<tag>`, workflow `BUN_VERSION` and `setup-bun` version must equal `packageManager` exactly (`validate:bun-pins`). The frontend stays Node-typed.
- **Do not try to replace a dependency with a Bun built-in here.** `Bun.YAML` loses duplicate-key detection (breaks `scripts/validate-workflows.mjs`). `Bun.redis` has no `multi`/`exec`/`watch`. `Bun.Image` is not reachable from `expo prebuild`'s Node. `bun test` does not replace Jest (frontend); the backend's move off Vitest is above. The global virtual store is unreachable under `linker = "hoisted"`, which Metro requires.
- **`bun run test` computes no coverage.** CI runs `test:coverage` + `coverage:check` against `packages/frontend/coverage-policy.json` (per-file pins, a no-regression ratchet). After genuinely raising coverage, run `coverage:record` and commit `coverage-baseline.json`. Detail: `packages/frontend/docs/TESTING-POLICY.md`.

## Bumping an Oxy SDK package (`bun add` reports success and changes nothing)

- **Shared versions live ONLY in `workspaces.catalog` in the root `package.json`.** A bump is one catalog edit plus `bun install`. Manifests and the root `overrides` name the package as `"catalog:"`.
- **`bun add`/`bun update` are the wrong tools** — an override beats a workspace range, so they print success and leave the old version in `node_modules` and `bun.lock`. Doctor rejects a manifest or override re-pinning a catalogued package to a literal range, and rejects `@oxy.so/bloom` in the root `dependencies`.
- Packages with a single consumer and an exact pin (`@crowdsource.you/core*`, `@oxy.so/federation`, `@oxy.so/protocol`) are deliberately NOT catalogued.
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

Oxy Services 13.15.5 changes the Android device-session module. A lockfile
update or JavaScript deployment does not update that module in an existing
installation; include the dependency in a new native build to ship the change.
The CI autolinking check verifies module discovery and source presence, not a
compiled or distributed Android binary.

```bash
cd packages/frontend/android
NODE_ENV=production ./gradlew :app:assembleRelease -x lintVitalRelease \
  -PreactNativeArchitectures=arm64-v8a -Dorg.gradle.jvmargs="-Xmx8g -XX:MaxMetaspaceSize=1g"
```

- **`NODE_ENV=production` is REQUIRED** or `export:embed` aborts and the APK ships with NO embedded bundle (verify: `unzip -l app-release.apk | grep index.android.bundle`).
- Build arm64-only; the multi-ABI build fails at the x86 CMake task.
- **Metro dev builds must run from `packages/frontend`**, not the repo root — from the root Expo resolves the legacy `expo/AppEntry` and returns HTTP 500.
- **Development bundles use Noxcturnal**, Expo's oxc transformer (`experiments.noxcturnalTransformWorker` in `app.config.js`). It stays inactive when the project has any Babel config other than the bare Expo preset, so the frontend has no Babel config file: `@/` resolves through `tsconfig.json` paths (Jest maps it in `moduleNameMapper`), and `babel-preset-expo` adds the worklets plugin and the `import.meta` transform itself. Production exports (`NODE_ENV=production`) still use Babel, because Noxcturnal keeps the requires of dead platform branches and pulls native-only packages into the web bundle. Run with `LOG_EVENTS=<file>` to see which files fall back to Babel and why (`transform:noxcturnal:fallback`).
- **The web export's experimental Metro optimization flags are not native build flags.** On the current Expo/React Native versions, enabling both for Android leaves an ESM import of `react-native-css/native-internal` in the generated script and Hermes refuses it. The normal Android production export succeeds. Revalidate the generated Hermes bundle before enabling those flags for native; a successful Metro graph alone is not enough.

### Native root profiles and stack replacement

The retained native `/you` profile owns its internal tab selection locally.
Switching to Media, Replies or a lane must not replace the root `(tabs)` route
with `/@handle/...`; doing so discards the root pager and its retained state.
A pushed or cold-linked canonical profile still updates its own child route.

The version-pinned `react-native-screens@4.30.0` Bun patch additionally backports
[upstream root replacement fix #5103](https://github.com/software-mansion/react-native-screens/pull/5103).
The experimental Android stack previously processed the removal half of a valid
root replacement as a pure pop and threw “Attempt to pop last screen from the
stack”. A cold unknown URL followed by “Go home” reproduced this on a Pixel 8a
with the official dependency release APK. The root fragment has no FragmentManager
back-stack entry: a replacement batch must remove it directly before installing
the pending root, while a pure last-screen pop remains forbidden. The patch
preserves the top-screen and final nonempty-stack invariants; it catches no
exception and adds no application navigation workaround.

When an official release includes the upstream fix, replace this portion of the
pinned patch through the normal dependency upgrade and verify cold 404 → Home,
subsequent push/back, root profile tab retention and canonical profile navigation
on a normal signed Android release. Preserve the existing unrelated screens
patches until their own upstream fixes are adopted. Changes to a Bun-patched
package must start with `bun patch` in an isolated worktree: installed files can
be hard-linked across worktrees before patch preparation. Generated `.bun-tag`
cache markers are not source patches and must not be added to the tracked diff.

Android's predictive gesture **preview** remains disabled by this app's manifest
so root-tab history reaches JavaScript; a successful edge-swipe Back test does
not establish that the system preview animation is enabled. Keep that distinction
in native acceptance evidence.
