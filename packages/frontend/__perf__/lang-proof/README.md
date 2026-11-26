# Bloom language proof: Settings -> Notifications

DEV ONLY. Measures `components/settings/pages/notifications.tsx` (the
TypeScript screen) against its hand port in Bloom's own language,
`notifications.bloom`, on the same deterministic fixture. Nothing here reaches
the production app: the folder is outside `app/`, the Metro and Expo hooks run
only with `BLOOM_LANG_PROOF=1`, and coverage skips `__perf__/`.

## The fixture

The screen reads three app hooks. `fixture.ts` holds a deterministic world
(the branch: `pending`, `signedOut`, `loading`, `loaded`; the stored
preferences; how a save ends) and `stand-ins/` replaces those hooks with it.
Jest mocks the hooks with the stand-ins; the web proof app resolves them with
`metro.js`, for the screen's own files only. `OxyAuthPrompt` is a stand-in that
draws its two props (the real one needs a live `<OxyProvider>`).

## Cost and timing (Jest)

```bash
cd packages/frontend
bun run test:perf __perf__/lang-proof                    # the TypeScript screen
PROOF_SCREEN=bloom bun run test:perf __perf__/lang-proof # the port, once it compiles
```

Fibers, host fibers, hook slots and context reads under the screen per branch
(the walk of Bloom's `parity/cost.parity.test.tsx`); mount and update times,
median and p95 (`PROOF_PERF_RUNS`, default 200, after `PROOF_PERF_WARMUP`, 30).
Results: `results/<screen>.json`.

## Bundle bytes (web)

```bash
cd packages/frontend
NODE_ENV=production EXPO_PUBLIC_ENV=production EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 \
  EXPO_UNSTABLE_TREE_SHAKING=1 npx expo export --platform web --source-maps external \
  --output-dir <out>
node __perf__/lang-proof/bundle-bytes.mjs <out> components/settings/pages/notifications.tsx
```

The module's minified bytes from the source maps, its gzip and brotli alone,
its chunk's sizes and the export's total.

## Pixels (web)

```bash
cd packages/frontend
BLOOM_LANG_PROOF=1 npx expo export --platform web --output-dir <proof>
CHROME_PATH=<chrome> node __perf__/lang-proof/screenshot.mjs capture <proof> <shots> ts
CHROME_PATH=<chrome> node __perf__/lang-proof/screenshot.mjs capture <proof> <shots> bloom
node __perf__/lang-proof/screenshot.mjs diff <shots>/ts-loaded@2x.png <shots>/bloom-loaded@2x.png <diff.png>
```

`BLOOM_LANG_PROOF=1` makes `app/` of the export `__perf__/lang-proof/app`: the
screen alone at 600 points, under Mention's stylesheet, Bloom provider (light,
Mention's colour preset, real fonts) and i18n. `/?screen=ts|bloom&state=<branch>`
picks the screen and branch. Captures are light, reduced motion, 1x and 2x.

## Baseline (phase A, the TypeScript screen)

`results/ts.json` and `results/bundle-ts.json`. Jest on an i9-14900K (32
threads), node 24, jest-expo (ios), development React, other agents' work on
the machine (load average about 4 to 6). The signed-out branch draws the
stand-in prompt.

## Spec friction found writing `notifications.bloom` (draft 0)

Would not compile as written:

1. **`t()` is Foreign everywhere.** react-i18next's `TFunction` is conditional and
   overloaded, so each of the 20 `t(…)` results passed to `Text`, `.description`,
   `.label` or a prop is B0601, and there is no inline ascription. A `tr(key,
   fallback)` member wrapper compiles but hides the literal keys from
   `validate-i18n`. Fix: at a position with an expected Bloom type, accept a
   Foreign value and emit the TypeScript annotation there (tsc still checks it);
   add an inline ascription `(expr: String)`; ship type overrides for common
   libraries (`t: (String, defaultValue: String?) -> String`).
2. **`Partial<S>` cannot be constructed.** Expressions take no type arguments
   (`Partial<Prefs>(likes: v)` parses as comparisons) and there is no record
   literal. Fix: `Prefs.patch(likes: v)`, or type arguments after an UpperCamel
   name in expression position.
3. **No keyed field access.** `prefs[key]` and `update({ [key]: value })` need two
   seven-arm `match` functions. Fix: key paths (`\Prefs.likes`,
   `prefs[keyPath: k]`, `Prefs.patch(k, v)`), compiled to `prefs[k]` and `{ [k]: v }`.

Ambiguous:

4. **Awaiting an annotated TS function.** After `let update: async (Partial<Prefs>)
   -> Unit = section.update`, does `await update(p)` yield `Unit` (a Bloom async
   function) or `Result<Unit, Error>` (a TS promise)? The rule is by provenance,
   which the annotation erases. Fix: a `Promise<T>` type for TS promises (`await`
   gives `Result<T, Error>`); `async (A) -> R` stays Bloom's.
5. **Foreign granularity.** Is a TS call result Foreign as a whole when one member
   is a mapped type (`value: Partial<…[K]>`), or only that member? And how is a TS
   generic bound (`<K extends MergedSection>`) checked? Fix: per member; bounds
   check the argument against the bound.
6. **Unawaited async call in a `Binding` setter** (`set: { on in
   updatePreference(key, on) }`). Events may be async, a setter is `(T) -> Unit`.
   Fix: every handler position (events, `Binding(set:)`) accepts an async closure
   run as a completing task; an unawaited async call elsewhere is an error, with
   `Task { … }` as the explicit form.
7. **`case .ok(_) => {}`**: an empty block or an empty closure? And `Unit`'s value
   is never named. Fix: an arm's `{` is always a block; name `()` as `Unit`.
8. **Statement `match`.** Its arms end in `{}` (Unit) and `toast(…)` (a TS value):
   is it an expression that must unify? Fix: in statement position it is not.
9. **No `finally`.** `saving = false` after the `match` is skipped by a panic,
   which the TypeScript `finally` covers. Fix: `defer { … }`, compiled to try/finally.
10. **`Prefs(..stored)` soundness.** Object spread lets an explicit `undefined`
    (or a `null` from the wire) replace a default, so a `Bool` field holds
    `undefined`. Fix: spread a `Partial` per field (`stored.likes ?? true`).
11. **TS component or function?** `SettingsSkeleton()` (all-optional props) and
    `OxyAuthPrompt(label:, description:)`: which TS values are nodes, and what
    they compile to, is not stated. Fix: an UpperCamel value typed
    `(props: P) => ReactNode`, `ComponentType` or an exotic component is a node,
    compiled to `Embed(createElement(C, props))`.
12. **`fn … -> View` as a member** (`toggleRow` reads `prefs`): inlined UI, or a
    memoised handler closure as the member table says of `fn`? Fix: a `-> View`
    member is inlined; its reads are the caller's dependencies. Closures inside a
    builder (each row's setter) need a stated memo rule too.
13. **`pub default view`**: `default` is not in the keyword list; only `screen` is
    described as a default export. Settings pages are default-exported
    components loaded by a registry, not routes.
14. **`Error`** (the `.err` payload of an awaited TS promise) is not in the type table.
15. **Prelude shadowing**: the prelude `toast` is the language's wrapper over
    `@oxy.so/bloom/toast`; say that an import shadows a prelude name.
16. **Hook destructuring cannot carry annotations**, so the Foreign section takes
    four lines. Fix: ascription in patterns, `let { value: (stored: Partial<Prefs>) }`.

Would make an agent stumble:

17. **`navigate` is not every router.** The cheat sheet says `.onPress(navigate(…))`
    over `router.push`; a settings page must push inside the settings modal with
    `useSettingsRouter().push`. Say that a hook-provided router stays a TS call,
    and keep the phase 1 route enum off TS routers' arguments.
18. **Resolution is unspecified**: `@/` tsconfig paths, package `exports`
    conditions (`react-native` resolves `@oxy.so/services` to source) and
    platform files. Fix: resolve and type exactly as tsc does with the project's
    tsconfig (through the TypeScript API).
19. **Gates do not see `.bloom`**: `validate-i18n`, `validate-logger-error-args`
    and the coverage policy match `\.(tsx?|jsx?)$`, Biome does not format it.
    The named-argument form keeps `t("key", defaultValue: "…")` scannable once
    the gates add the extension.
20. **Both `notifications.tsx` and `notifications.bloom` exist**: an import
    without an extension is ambiguous (spec 10 imports Bloom with `.bloom`).

Measurement caveat (not the spec): the TypeScript screen keeps the codemod's
`Embed(<>{toElement(Toggle(…))}</>)` around each trailing control, a language
root per row; the port writes `.trailing(Toggle(…))`, so a cost difference in
phase B includes that simplification.
