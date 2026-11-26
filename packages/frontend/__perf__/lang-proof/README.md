# Bloom language proof: Settings -> Notifications

Settings -> Notifications is the first Mention screen in Bloom's own language:
`components/settings/pages/notifications.bloom`, compiled by bloomc
(`@oxy.so/bloom-language-compiler`) and drawn by `settingsPages.tsx` with
`toElement(NotificationSettingsScreen())`. This folder is DEV ONLY: it measures
the port against the TypeScript it replaced on one deterministic fixture.
Nothing here reaches the production app: the folder is outside `app/`, the
Metro and Expo hooks run only with `BLOOM_LANG_PROOF=1`, and coverage skips
`__perf__/`.

## The three forms (`screens.tsx`)

- `original`: `variants/original.tsx`, the screen as it shipped (the codemod's
  output: a component, an `Embed(<>{toElement(…)}</>)` around each control).
- `cleaned`: `variants/cleaned.tsx`, the same in the embedded language at its
  best (a `view()`, a row helper, no hand memoisation).
- `bloom`: the `.bloom` port. bloomc writes its own memo cache (`"use no memo"`).

A `view` is a node factory, drawn with `toElement(View())`. A module is never
both `X.tsx` and `X.bloom` (B0610), so the TypeScript lives here.
`notifications.d.bloom.ts` is bloomc's declaration output, read through
`allowArbitraryExtensions`; regenerate it after changing the port with
`npx bloom-lang-dts --root . components/settings/pages/notifications.bloom`.

## The fixture

The screen reads three app hooks. `fixture.ts` holds a deterministic world
(the branch: `pending`, `signedOut`, `loading`, `loaded`; the stored
preferences; how a save ends) and `stand-ins/` replaces those hooks with it.
Jest mocks the hooks with the stand-ins; the web proof app resolves them with
`metro.js`, for the screens' own files only. `OxyAuthPrompt` is a stand-in that
draws its two props (the real one needs a live `<OxyProvider>`).

## Cost and timing (Jest)

```bash
cd packages/frontend
bun run test:perf __perf__/lang-proof        # all three, interleaved
PROOF_SCREEN=bloom bun run test:perf __perf__/lang-proof
```

Fibers, host fibers, hook slots and context reads under the screen per branch
(the walk of Bloom's `parity/cost.parity.test.tsx`); mount and update times,
median and p95 (`PROOF_PERF_RUNS`, default 200, after `PROOF_PERF_WARMUP`, 30),
the three forms interleaved run by run in a rotating order. It also checks the
behaviour: a toggle saves its own key, Open navigates, a failed save toasts and
clears `saving`. `jest.perf.config.js` compiles `.bloom` with the compiler's
Jest transformer. Results: `results/compare.json`.

## Bundle bytes (web)

```bash
cd packages/frontend
NODE_ENV=production EXPO_PUBLIC_ENV=production EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 \
  EXPO_UNSTABLE_TREE_SHAKING=1 npx expo export --platform web --source-maps external \
  --output-dir <out>
node __perf__/lang-proof/bundle-bytes.mjs <out> components/settings/pages/notifications.bloom
```

The module's minified bytes from the source maps, its gzip and brotli alone,
its chunk's sizes, the entry scripts and the export's total. The TypeScript
forms were measured by pointing `settingsPages.tsx` at them for the export.

## Pixels (web)

```bash
cd packages/frontend
BLOOM_LANG_PROOF=1 NODE_ENV=production npx expo export --platform web --output-dir <proof>
for s in original cleaned bloom; do
  CHROME_PATH=<chrome> node __perf__/lang-proof/screenshot.mjs capture <proof> <shots> $s
done
node __perf__/lang-proof/screenshot.mjs diff <shots>/original-loaded@2x.png <shots>/bloom-loaded@2x.png <diff.png>
```

`BLOOM_LANG_PROOF=1` makes `app/` of the export `__perf__/lang-proof/app`: the
screen alone at 600 points, under Mention's stylesheet, Bloom provider (light,
Mention's colour preset, real fonts) and i18n. `/?screen=<form>&state=<branch>`
picks the form and branch. Captures are light, reduced motion, 1x and 2x.

## Results (compiler pack sha256 0bc2f068, core b180b6221, tooling dc9c60e8b)

The installed pack is now sha256 7a816e33 (core b000d5a52 plus the tooling
fixes). Its output for the port is byte-identical to the measured build, and the
web build no longer warns B0602.

`results/compare.json`, `results/bundle.json`, `results/compile.json`. Jest on an
i9-14900K (32 threads), node 24, jest-expo (ios), development React, the three
forms interleaved, other agents' work on the machine (load average 7 to 11).

React cost (exact). `cleaned` and `bloom` are identical in every branch:

| Branch                       | original fibers / hooks / contexts | cleaned         | bloom           |
| ---------------------------- | ---------------------------------- | --------------- | --------------- |
| pending, loading             | 110 / 355 / 54                     | 109 / 354 / 54  | 109 / 354 / 54  |
| signed out (stand-in prompt) | 17 / 19 / 3                        | 16 / 18 / 3     | 16 / 18 / 3     |
| loaded                       | 413 / 535 / 273                    | 396 / 534 / 257 | 396 / 534 / 257 |
| saving                       | 434 / 556 / 279                    | 417 / 555 / 263 | 417 / 555 / 263 |

Time, median / p95 in ms (200 runs after 30; Profiler figures are whole ms):

|                                   | original      | cleaned       | bloom         |
| --------------------------------- | ------------- | ------------- | ------------- |
| mount (wall)                      | 25.92 / 37.13 | 24.43 / 43.39 | 23.54 / 35.06 |
| mount (Profiler)                  | 22 / 31       | 21 / 33       | 20 / 31       |
| toggle press, `saving` on (wall)  | 9.17 / 15.82  | 8.68 / 16.09  | 7.81 / 12.47  |
| toggle press (Profiler)           | 7 / 13        | 7 / 14        | 6 / 10        |
| save settles, `saving` off (wall) | 17.80 / 28.39 | 17.49 / 29.87 | 10.84 / 18.57 |
| save settles (Profiler)           | 6 / 12        | 6 / 12        | 0 / 2         |
| whole update (wall)               | 27.26 / 40.89 | 26.66 / 42.48 | 19.38 / 30.38 |

The React Compiler does not memoise either TypeScript form: it bails on
`try`/`finally`, so neither carries a `c()` cache, in Jest or in the production
bundle. bloomc writes its own cache (per-child scopes), so when `saving` flips
back the port re-renders almost nothing.

Bundle, production web export (bytes: minified / gzip / brotli):

|          | module             | `MentionSettingsModal` chunk | entry   | all JS (gzip)       |
| -------- | ------------------ | ---------------------------- | ------- | ------------------- |
| original | 5320 / 1282 / 1061 | 148065 / 38278 / 30510       | 9856928 | 30605602 (11421462) |
| cleaned  | 3404 / 1173 / 984  | 146213 / 38229 / 30592       | 9857649 | 30604471 (11421602) |
| bloom    | 4711 / 1745 / 1468 | 147524 / 38827 / 30961       | 9857649 | 30605782 (11422196) |

The entry grows 721 bytes for both `view()` forms (tree shaking keeps `view`).
The port's extra bytes over `cleaned` are its memo cache (38 slots), the
module-local `$settle` helper a matched `await` compiles to, the two key-to-field
`match` functions and the per-field `Partial` spread.

Compile, per file as Metro runs it (ms, median): bloomc alone 0.94 (p95 1.44);
the Bloom step plus Babel with Expo's preset and the React Compiler: original
25.50, cleaned 12.66, bloom 15.38 (bloomc 1.34 of it).

Pixels: original, cleaned and bloom are pixel-equal (0 differing pixels) in all
four branches at 1x and 2x, and equal to the phase A captures. The emitted
TypeScript type-checks with 0 errors in Mention's tsc context, so every
`satisfies` boundary holds.

## Spec friction found writing `notifications.bloom` (draft 0)

Draft 0.1 took in 1 (a Foreign value is accepted at an expected Bloom type,
emitted as `satisfies`), 2 (`S.patch(…)`), 4 (`Promise<T>`), 5 (resolution and
component rules), 6 (`task { }`), 7 (`{}` after `=>`, `()`), 9 (`defer`), 10
(per-field `Partial` spread), 12 (a member `fn -> View` is inlined), 13
(`default`), 14 (`Error`), 15 (shadowing), 17 (cheat sheet), 18 (tsconfig paths)
and 20 (B0610). Key paths (3) are phase 1. The port is written in 0.1.

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

## bloomc findings (phase B)

Fixed after the measurements, none changing the screen's output: 1 and 4 in
core b000d5a52; 2 and 3 in tooling (the adapters pass the root and an absolute
filename; `bloom-lang-dts` writes the declarations). 5 is phase 1.

1. `pub default view` emitted only a named export (code and `.d.bloom.ts`);
   `screen` emits `export default`. The port is `pub view`, imported by name.
2. The Metro and Jest adapters called bloomc without the project root and Metro
   passed a project-relative filename, so every import warned B0602 and lost
   its types in the build (the output differed only in the `satisfies` text).
3. No CLI wrote `X.d.bloom.ts`.
4. The `.d.bloom.ts` carries the module's value imports and its private
   `$Result` type.
5. Nothing in an app's pipeline type-checks the emitted TypeScript (Babel strips
   types), so the `satisfies` boundaries hold only where someone runs tsc on it.
6. A `view` used from TypeScript is a node factory: `toElement(View())`, never
   `<View />`; the spec does not say so.
7. Known: a matched `await` compiles to a module-local `$settle` helper (an async
   call and an object per await).
