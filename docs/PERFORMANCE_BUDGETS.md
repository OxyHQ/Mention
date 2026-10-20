# Performance budgets

**Scope of this document, stated up front:** issue #703 asked for SLOs and
regression budgets across a long list of backend and client paths. This
document is deliberately narrower than that list. An SLO nobody measures is
worse than none — it looks like a commitment while giving the team nothing
to hold it against — so this covers exactly the paths that have a real
measurement pipeline BEHIND them today, and says plainly, for every other
path in the original ask, what instrumentation exists and what is still
missing before a numeric budget would mean anything.

## What is measured and enforced today

### Client JS/web bundle size

`packages/frontend/bundle-budgets.json` is a real, CI-enforced regression
budget — `packages/frontend/scripts/analyze-bundle.js --ci` fails the build
past any of:

| Budget | Ceiling |
| --- | --- |
| Total bytes | 20.1875 MiB |
| JavaScript bytes | 15.5 MiB |
| Initial JavaScript bytes | 5.875 MiB |
| Initial JavaScript gzip bytes | 1.65625 MiB (target: 1.6 MiB) |
| Font bytes | 4 MiB |
| Largest single file | 7.5 MiB |

Wired into `.github/workflows/ci.yml`'s "Enforce bundle budgets" step, which
also diffs the merge-queue entry's export against `main`'s baseline (pull
requests skip it; the queue entry is the tree that ships). This is the one item
on the original SLO list that already has the property the rest of this
document argues for: a number, a place it is measured, and a build that
fails when the number is exceeded.

These are CEILINGS, and the distance to them is not the interesting number —
where the build actually sits is. Measured from a local `expo export --platform
web` (2026-09-05):

| Signal | Measured | Ceiling | Long-term target |
| --- | --- | --- | --- |
| Initial JavaScript bytes | 7.88 MiB | 8.5 MiB | — |
| Initial JavaScript gzip bytes | **1.93 MiB** | ~2.35 MiB | ~1.9 MiB |
| Font bytes | 1.91 MiB | 4 MiB | — |

So the initial gzip figure is ~30 KiB from its target, not ~470 KiB — reading
the gap off the ceiling instead of off the build overstates it by more than an
order of magnitude. `MaterialCommunityIcons.ttf` alone is 1.25 MiB of the 1.91
MiB font total, against 380 KiB for Ionicons, which the app imports directly in
86 files; that ratio is the one worth explaining before the font budget is
treated as comfortable.

The total-bytes ceiling moved 20.5 → 20.75 MiB with the published Oxy SDK
adoption (`docs/audits/2026-10-04-catalog-and-bundle-followup/`), and
20.75 → 20.8125 MiB (+64 KiB) with the 2026-10-12 minor-and-patch dependency
group (#1371): main sat 4 KiB under the ceiling and the group's patch releases
(TanStack Query, dotlottie, LiveKit and others) add 7.17 KiB, every other
ceiling unchanged and initial JavaScript +2.83 KiB.

Alia SDK 21 with Bloom 10.17 (2026-10-17) moves the total-bytes ceiling 19.5 → 19.6875 MiB and
the JavaScript ceiling 15.125 → 15.3125 MiB (+192 KiB each); every other ceiling is unchanged.
Measured on one `expo export --platform web` each of main `b09efb2c9` (Bloom 10.16, SDK 15.8)
and the branch (SDK 21.2):

| Signal | Main | SDK 21 | Change |
| --- | --- | --- | --- |
| Total bytes | 20,362,177 | 20,572,151 | +209,974 |
| JavaScript bytes | 15,727,238 | 15,937,212 | +209,974 |
| Initial JavaScript bytes | 5,424,936 | 5,457,887 | +32,951 |
| Initial JavaScript gzip bytes | 1,500,701 | 1,511,946 | +11,245 |

The growth is the chat that SDK 21 and Bloom 10.17 add (the multi-agent header, host tools and
renderers, the sheet's recent conversations, Bloom's Markdown), and almost all of it is deferred:
the app mounts the SDK's `AliaAskProvider` from `@alia.onl/sdk/ask`, which loads the sheet with
the first Ask Alia, and the `deferredSources` gate asserts the SDK's `AliaChatSheet` stays out of the
initial chunk. What reaches the initial chunk is the provider and the modules the sheet shares
with the SDK's own lazily loaded voice call, which `extractCommonChunk` hoists into `__common`.

The canonical Experience feature (#1408, 2026-10-16) moves no ceiling. Measured
on one `expo export --platform web` each of main `fa91c8947` and the merged
branch, same analyzer, Clarity SDK 0.6.0:

| Signal | Main | With Experience | Change |
| --- | --- | --- | --- |
| Total bytes | 20,047,386 | 20,166,957 | +119,571 |
| JavaScript bytes | 15,413,519 | 15,532,984 | +119,465 |
| Initial JavaScript bytes | 5,465,353 | 5,469,574 | +4,221 |
| Initial JavaScript gzip bytes | 1,515,738 | 1,517,174 | +1,436 |

The history, the editor and the Clarity client load behind one lazy boundary,
only when the profile Experience tab opens; the `deferredSources` gate asserts
they stay out of the initial chunk. Most of the deferred growth is the new copy
in the 15 per-locale catalogues.

Clarity SDK 0.5.0 checked its responses with Zod 4. That made the Experience
chunk zod's second async consumer, which `extractCommonChunk` hoisted back into
`__common` with every locale: +586,016 initial JavaScript bytes and +102,396
gzip, and the zod `deferredSources` gate failed as designed. SDK 0.6.0
(OxyHQ/Clarity#116) checks Experience in plain TypeScript and no longer depends
on zod, so the notification validators stay its one way in.

The JavaScript-bytes ceiling was raised from 13 MiB by
`4ca5f1e feat(i18n): translate all fourteen locales` — the locale catalogues are
2.3 MB on disk but are correctly per-locale `import()`s (`lib/i18n.ts`), so they
count against the total and NOT against initial JavaScript.

It was raised again, from 14.5 to 15 MiB, by the move to Bloom 5.1
(`@oxy.so/bloom` 5.0 + 5.1): the build measured 14.63 MiB of JavaScript against
14.31 MiB before, with initial JavaScript still inside its ceiling (8.08 of
8.5 MiB). Most of the +0.32 MiB is Bloom's own message catalogs: since 5.1
every Bloom family speaks the app's language, and unlike Mention's catalogues
Bloom's are static imports carrying all fifteen languages, so the ones for the
families Mention imports ship whole. The fix that gives this back belongs in
Bloom — load only the active language, as `lib/i18n.ts` does here — and is
recorded there as a follow-up.

It was raised from 15 to 15.125 MiB (+128 KiB) by the Oxy Files SDK
(`@oxy.so/contracts` 4.24.0, `@oxy.so/core` 4.21.0, `@oxy.so/services`
11.12.0, OxyHQ/Mention#1430). Measured on one `expo export --platform web`
each of main `f064dbe89` (contracts 4.21.0, core 4.17.0, services 11.8.0) and
the branch, same analyzer:

| Signal | Main | With the SDK | Change |
| --- | --- | --- | --- |
| Total bytes | 20,305,797 | 20,383,811 | +78,014 |
| JavaScript bytes | 15,671,388 | 15,749,026 | +77,638 |
| Initial JavaScript bytes | 5,390,065 | 5,418,632 | +28,567 |
| Initial JavaScript gzip bytes | 1,491,227 | 1,498,756 | +7,529 |

Every byte is the SDK's own: core +58 KiB (its assets and apps clients and the file,
trash and app-access strings in each of its locale catalogues), services
+45 KiB (the app-assertion manager, the file trash screen and its actions,
the per-file application access section, the display-currency selector),
contracts +6 KiB (the app-assertion client). Main sat 56 KiB under the old
ceiling; no other ceiling moves, and initial JavaScript stays inside its own.

The total ceiling was raised from 19.8 to 20.5 MiB by the empty feed's
sticker (Oxy's shared catalogue, drawn by Bloom's `Sticker`): measured 20.32
MiB against 18.96 MiB on `main`. 1.18 MiB of the +1.36 MiB is dotLottie's
WebAssembly renderer, bundled as an asset so it is served from this origin
rather than a third-party CDN; it is FETCHED only when a sticker animates, so it
counts against the total and not against initial JavaScript. The rest is
dotLottie's JavaScript, which does land in the initial chunk (+34 KiB gzip,
1.70 → 1.74 MiB): Bloom loads its optional Lottie player with a synchronous
`require`, which Metro keeps eager. Loading it with `import()` instead belongs
in Bloom and would give those bytes back.

The same move raised the feed row-cost ceilings (`__perf__/budgets.json`) to
their measured values: every row kind reads one more context (the locale Bloom
components now resolve their strings from), `text` gains 5 components and
0.125 host nodes, and `linkPreview` gains the most (+30 components, +9 context
reads, +7.125 host nodes, +4 hooks) from Bloom 5's `Card`, which now paints the
shared `Surface` material in layers. No request, query-observer or render count
moved.

### Initial JavaScript after #1216

Expo's web export moves every module that ANY two async chunks share into
`__common`, which the entry requires, so every page load downloads it before
anything renders (`@expo/metro-config` `serializeChunks.extractCommonChunk`,
unchanged in SDK 58). A lazy boundary only keeps a module out of the initial
JavaScript when it is that module's ONE way in: a second `import()` of the same
dependency, or a static import from any other route, hoists it straight back.
The OxyHQ/Mention#1216 work applied that rule to the composer, the video
replies panel, the settings dialog, the Syra rooms engine (via
`@syra.fm/sdk/client`) and Bloom's settings/contact-row/app-shell families
(Bloom 5.2 lean subpaths):

| Signal | Before (2026-09-28) | After | Ceiling | Target |
| --- | --- | --- | --- | --- |
| Initial JavaScript bytes | 8.08 MiB | 6.86 MiB | 7.25 MiB | — |
| Initial JavaScript gzip bytes | 2.09 MiB | 1.75 MiB | 1.85 MiB | 1.6 MiB |
| Initial JavaScript brotli bytes | 1.60 MiB | 1.35 MiB | — | — |

The ceilings sit ~5 % above the measured build and move down with each
further cut: after #1244 (lean SDK entries, Bloom's on-demand languages, the
notification validators out of startup) the export measured 6.57 MiB initial /
1.70 MiB gzip, so they are 6.9 / 1.78 MiB. They are never raised to make a PR
pass.

`bundle-budgets.json` also lists `deferredSources`: modules that must load on
demand. `analyze-bundle --ci` fails when one appears in an initial chunk, and
when an entry matches no module in the export (a rename must not leave a guard
that guards nothing).

The two TOTAL ceilings were raised again by Bloom 5.4.1 (#1244), from 18 to
19.8 MiB and from 15 to 16.45 MiB: the build measured 18.88 / 15.67 MiB. Bloom
now ships English inline and every other language as one on-demand module
covering all its families (`@oxy.so/bloom` 5.3+), so ~1.4 MiB of translations
moved OUT of the initial JavaScript, where every reader downloaded the strings
of all fifteen languages for the families on the page, INTO fourteen language
chunks of which a reader downloads one (56–190 KB minified, ~20 KB brotli). The
initial ceilings did not move; the initial JavaScript fell.

### Tree shaking (2026-10-15)

The web export is built with Expo's Metro tree shaking
(`EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 EXPO_UNSTABLE_TREE_SHAKING=1`, set on the
`build` and `build:analyze` scripts in `packages/frontend/package.json`, so CI's
budget export and the deploy export are the same build). Without it Metro keeps
every export of every module it reaches, so a barrel import pulls in the whole
barrel: `@oxy.so/core` and `@oxy.so/services` import `@oxy.so/contracts` from its
root, which carried every contract into startup — Kaana's inference schemas
among them (393 KiB of `@oxy.so/contracts` in `__common` before, 109 KiB after).
Bloom (1204 → 962 KiB), gesture-handler, keyboard-controller and the SDKs shrink
the same way. Measured on one `expo export --platform web` of the same commit:

| Signal | Before | After | Δ |
| --- | --- | --- | --- |
| Initial JavaScript bytes | 6.98 MiB | 6.10 MiB | −0.88 MiB (−12.5 %) |
| Initial JavaScript gzip bytes | 1.80 MiB | 1.59 MiB | −216 KiB (−11.7 %) |
| Initial JavaScript brotli bytes | 1.37 MiB | 1.21 MiB | −162 KiB (−11.5 %) |
| JavaScript bytes (all chunks) | 16.29 MiB | 14.96 MiB | −1.33 MiB |
| Total bytes | 20.71 MiB | 19.38 MiB | −1.33 MiB |

The long-term initial gzip target (1.6 MiB) is met. The ceilings moved down to
~5 % above the build (initial) and ~2 % (totals).

It is NOT a fix for everything Metro cannot split, and two of the largest
remaining startup costs survive it: zod 4's `export * as locales` namespace
(270 KiB of error-message translations for 40+ languages) is kept whole because
the namespace object is itself an export, and `@lottiefiles/dotlottie-web`
(160 KiB) is reached through Bloom's synchronous `require` (see the sticker note
above). zod enters startup through `@syra.fm/sdk/client`'s response schemas,
reached from two async chunks (the podcast-save client and the live runtime),
which `extractCommonChunk` hoists into `__common`.

Neither half has a fix in Mention, measured on 2026-10-15 (the fix landed in
the SDK — see the next section):

- **The locales cannot be shaken by changing imports.** zod's own
  classic schemas module (and zod/mini's) imports zod's core as a namespace
  (`import * as core`), and that core module itself re-exports `locales`. Metro's
  tree shaker treats a namespace import as a use of every export, so ANY zod 4
  schema in the graph carries all locales, whatever the app or an SDK writes.
  An export with all three consumers switched to `import * as z from 'zod'`
  (Mention's `types/validation.ts` and both Syra SDK files patched locally)
  still had every locale module in `__common` (62 source files, 91 zod modules
  against 92 before). This is why the Syra SDK's
  `import * as z` change, which esbuild confirms, did not move Mention's bundle.
- **zod has THREE async consumers, not two.** Besides the Syra client chunk
  (`lib/syraPodcasts.ts`) and the live runtime (`LiveFeatureRuntime`, via the
  SDK's live-engine validation module), Mention's own notification validators
  (`types/validation.ts`, loaded by `lib/notificationValidation.ts`) import it.
  Routing both Syra features through one lazy module would leave zod shared by
  two chunks and still in `__common`, while making a podcast save download
  LiveKit. zod leaves `__common` only when one chunk is its sole way in.

None of it RUNS at startup — the factories are defined, not required, until one
of those chunks loads — so the cost is the download and parse of ~490 KiB raw.

### zod out of startup (2026-10-15)

Fixed at the root, in the SDK: `@syra.fm/sdk` 0.18 checks its responses (the
client and the live-rooms engine) in plain TypeScript and serves its Zod
schemas only from `@syra.fm/sdk/schemas`, for server consumers (OxyHQ/Syra).
That leaves Mention's notification validators (`types/validation.ts`, behind
`lib/notificationValidation.ts`'s one `import()`) as zod's only way in, so zod
and its locales stay in that async chunk and leave `__common`. No Mention code
changed. Measured on one `expo export --platform web` (tree shaking on) of the
same commit, `@syra.fm/sdk` 0.16.2 vs 0.18.0:

| Signal | Before | After | Δ |
| --- | --- | --- | --- |
| Initial JavaScript bytes | 6,275,398 (5.98 MiB) | 5,695,652 (5.43 MiB) | −579,746 (−9.2 %) |
| Initial JavaScript gzip bytes | 1,641,225 (1.57 MiB) | 1,540,839 (1.47 MiB) | −100,386 (−6.1 %) |
| Initial JavaScript brotli bytes | 1,257,560 (1.20 MiB) | 1,177,799 (1.12 MiB) | −79,761 (−6.3 %) |
| `__common` bytes | 5,170,316 | 4,590,570 | −579,746 |
| JavaScript bytes (all chunks) | 15,645,157 | 15,648,050 | +2,893 |

The ceilings moved down to ~5 % above the build (5.7 MiB initial, 1.55 MiB
gzip). `bundle-budgets.json` lists `^/node_modules/zod/` under
`deferredSources`, so a second async consumer of zod — which would hoist it
straight back into `__common` — fails `analyze-bundle --ci` instead of costing
~560 KiB unnoticed. (`@oxy.so/contracts` still bundles its own zod 3 copy under
`@oxy.so/contracts/node_modules/zod/`, which that pattern deliberately does not
match; it is counted under `@oxy.so/contracts`.)

### Layout chunk preloads (2026-10-15)

`asyncRoutes` splits every route file into its own chunk, the eight `_layout`
files included, and expo-router requires every layout while it builds the route
tree — on every URL, before anything renders (8 of 8 requested on `/`, `/@user`
and `/p/<id>` alike). Only the startup JavaScript names them, so they were a
second round trip that began once `__common` and `entry` had downloaded and run
(~2.3 s into a cold load). `scripts/web-layout-preload.mjs` now writes one
`<link rel="preload" as="script">` per layout chunk into the exported
`index.html` (after `web-font-preload.mjs`, on `build` and `build:analyze`), so
the preload scanner fetches them beside the scripts. Page chunks (`index`,
`[id]`, …) are per-URL and this shell serves every path, so they are left alone.

Gates: `validate-frontend-static-output.mjs` fails an export whose `index.html`
does not preload exactly the layout chunks the startup JavaScript names, one per
directory under `app/` that holds a `_layout` (a Metro or expo-router naming
change fails the build instead of silently preloading part of the set);
`web-layout-preload:selftest` mutation-tests that; `e2e/tests/layout-preload.spec.ts`
asserts in a browser that the page requests exactly the preloaded layouts, each
once and through its preload (a mismatched URL or CORS mode would download it
twice).

Measured with no byte change, local export of the same commit with and without
the preloads (headless Chromium, 430×932, 4x CPU, 150 ms RTT, ~9 Mbit/s, cold
cache, median of 7 interleaved loads; profile and post median of 5–7):

| Page | LCP before | LCP after | Δ |
| --- | --- | --- | --- |
| `/` | 4.44 s | 4.14 s | −0.30 s |
| `/p/<id>` | 4.48 s | 4.24 s | −0.24 s |
| `/@gargron@mastodon.social` | 5.82 s | 5.59 s | −0.23 s |

Layout chunks finish at ~0.58 s instead of ~2.28 s. FCP moves only ~40 ms:
first paint is bound by downloading and running `__common` (1.3 MB brotli,
~2.0 s on this profile) and the ~0.8 s of CPU after it, not by the layouts. With
Alia's avatar runtime blocked (it competes for bandwidth on `/`) the home gain
is the same (−0.34 s).

### Shared Oxy account surfaces (2026-10-18)

Services 11.15.0, Core 5.5.0, Contracts 4.25.0 and Bloom 11.1.0 replace the
old account screens with the shared profile editors, storage categories, help,
and Oxy One catalogue. Account screens now load eagerly so opening and moving
between them does not wait for a JavaScript chunk. This is an intentional
startup cost; the subscription catalogue still does not enable purchases.

Measured with production `build:analyze` on main `319ab1dd6` and this integration,
using the same environment and analyzer (bytes):

| Metric | Main | Shared surfaces | Change |
| --- | --- | --- | --- |
| totalBytes | 20,606,564 | 21,103,092 | +496,528 |
| javascriptBytes | 15,971,625 | 16,180,683 | +209,058 |
| initialJavascriptBytes | 5,458,316 | 6,091,862 | +633,546 |
| initialJavascriptGzipBytes | 1,512,325 | 1,696,923 | +184,598 |

Source maps attribute the initial growth to the eager SDK screens and shared
Bloom controls: country flag artwork alone adds about 44 KiB of isolated gzip;
usage cards, text fields, profile editing and account navigation also enter the
initial graph. The video/poster add non-JavaScript assets. The singleton test
confirms Mention, Alia and Syra resolve one Services/Core/Bloom installation.
All nine deferred-source assertions still pass, including Alia's chat sheet,
Mention settings, LiveKit and Zod. No loader or skeleton was added to defer the
account UI again.

The four affected ceilings above reserve roughly 40–71 KiB beyond this measured
build. Font and largest-file ceilings stay unchanged, as does the 1.6 MiB initial
gzip target; this build is still above that target. The CI analyzer and baseline
comparison remain enabled.

### Unified Bloom screens and persistent Deck (2026-10-18)

The modular screen/header/scroll APIs, independent Deck navigation, richer
Insights and weekly recap charts, and translated settings introduce a measured
feature cost. Deck still loads actual screen modules lazily; its production
browser check covers skeletons, in-panel navigation, restored history/scroll,
and retry after a failed route chunk.

The comparison uses main `5571a86dc` with published Bloom 12.0.0 and the feature
with published Bloom 12.2.0 at `970ac616b063e4152b3650b1b5a639ad33ff9196`, including
the lean panel-hook imports. Both use `build:analyze`, identical optimized-graph
and tree-shaking flags, external source maps, and the unchanged analyzer. Maps
are excluded from byte totals. The feature measurements use the installed npm package, with no source mirror.

| Metric | Main | Unified screens and Deck | Change | Ceiling | Remaining headroom |
| --- | --- | --- | --- | --- | --- |
| totalBytes | 21,108,095 | 21,363,484 | +255,389 | 21,423,495 | 60,011 |
| javascriptBytes | 16,186,835 | 16,441,195 | +254,360 | 16,507,266 | 66,071 |
| initialJavascriptBytes | 6,092,384 | 6,168,581 | +76,197 | 6,236,559 | 67,978 |
| initialJavascriptGzipBytes | 1,692,093 | 1,720,784 | +28,691 | 1,765,382 | 44,598 |

The four ceilings were calibrated by adding the measured feature-minus-main
delta to their previous values, preserving existing headroom. The final gesture
cancellation fix uses 22 raw bytes and 13 gzip bytes of that margin; ceilings
were not raised again. Font and largest-file ceilings, all nine deferred-source guards,
the analyzer and baseline comparison remain unchanged. The 1,677,722-byte
initial gzip target is unchanged and remains missed by 43,062 bytes; the ceiling
is a regression guard, not a claim that the performance target has been met.

Source-map attribution places the growth in the requested Bloom charts and
screen/panel machinery. Oxy Services/Core/Contracts and Reanimated generated
startup bytes are unchanged, and the graph contains one Bloom installation.
Moving hook-only consumers to Bloom's lean entry removes 199,846 initial raw
bytes and 58,435 gzip bytes compared with importing the full app-shell barrel.
The source-only development mirror adds roughly 200 KB raw and 91 KB gzip over
the compiled package, so it is not the release comparison artifact.

A shared analytics entry and granular chart subpaths were measured separately
and together. They did not recover the previous startup ceilings and would add
public entrypoints and route coupling for marginal savings. The shipped API
keeps the simple lean-hook boundary; future reductions must preserve the shared
screen behavior and are still measured against the unchanged gzip target.

### Reanimated's layout animations and the feed's first request (2026-10-15)

Two root causes, each measured on its own export of the same commit
(headless Chromium, 430×932, 4x CPU, 150 ms RTT, ~9 Mbit/s, cold cache).

**Gesture Handler kept all of Reanimated.** Its Reanimated wrapper (`src/handlers/gestures/reanimatedWrapper`, patched by `patches/react-native-gesture-handler@2.32.0.patch`) loads
Reanimated with `require('react-native-reanimated')` (an optional peer
upstream). A CommonJS `require` hands Metro the whole module, so tree shaking
has to keep every Reanimated export — ~100 layout-animation presets (Zoom,
Flip, Bounce, Rotate, …), the screen transitions and the rest — none of which
Mention or Bloom uses. A bun patch (`patches/react-native-gesture-handler@2.32.0.patch`,
documented in `patches/README.md`) imports by name the four members it reads.
What stays of the layout animations (101 KiB) is Reanimated's own web
layout-animation runtime, which every animated component imports, and the
Fade and Slide presets the app and Bloom use.

| Signal | Before | After | Δ |
| --- | --- | --- | --- |
| Initial JavaScript bytes | 5,695,652 | 5,464,883 | −230,769 (−4.1 %) |
| Initial JavaScript gzip bytes | 1,540,839 | 1,515,556 | −25,283 |
| Initial JavaScript brotli bytes | 1,177,799 | 1,158,657 | −19,142 |
| Reanimated in `__common` | 722 KiB | 500 KiB | −222 KiB |

**The feed's first request waited for the whole screen.** A cold feed's first
page left from the React Query observer's subscription, which React makes only
after the whole screen has rendered and committed: on `/` the request went out
~130 ms after the feed itself had rendered, with the main thread then idle for
most of the response. `useFeedQuery` now starts the read during render (TanStack's
`usePrefetchInfiniteQuery` pattern, gated on the observer's own `active`), and
the observer joins it. Preloading the home page chunk as well was measured and
NOT kept: the chunk then arrives at ~0.35 s instead of ~2.9 s, but the request
leaves at the same moment, because rendering the shell above the feed — not the
chunk — is what it waits for.

Both together, against the export before them (median of 9 interleaved cold
loads on `/`, 5 on a post and a profile; production API):

| Page | FCP | LCP | First feed request | First row | Long tasks |
| --- | --- | --- | --- | --- | --- |
| `/` | 2.67 → 2.63 s | 4.08 → 3.96 s | 3.21 → 3.06 s | 3.97 → 3.84 s | 1.43 → 1.42 s |
| `/p/<id>` | 2.64 → 2.62 s | 4.19 → 4.07 s | 3.48 → 3.37 s | 3.89 → 3.86 s | 1.25 → 1.23 s |
| `/@gargron@mastodon.social` | 2.63 → 2.60 s | 4.71 → 4.76 s | 3.49 → 3.43 s | 4.38 → 4.34 s | 1.59 → 1.59 s |

The profile's LCP is its banner image, which neither change touches; its
difference is inside the run-to-run spread.

**It still waited for the viewer to resolve (2026-10-19).** Starting the read
during render only helps once the feed renders, and nothing account-dependent
renders before `AccountSwitchReset` has resolved the viewer — on a signed-out
cold load that is the SDK's whole cold boot. `lib/bootFeedRead` now starts the
home feed's first page from the root layout's module scope, as the viewer the
device last had (anonymous, or the account the bearer names once it lands),
and the feed takes it only when it resolves as that same viewer
(`services/feedPageRead`). Measured with a local `expo export` of main
`73fbe89b7` and of the branch, each served at the production origin against
the production API (headless Chromium, 430×932, 4x CPU, 150 ms RTT, ~9 Mbit/s,
cold context, signed out, median of 9 interleaved loads of `/`):

| Signal | Main | Branch |
| --- | --- | --- |
| First feed request | 3.05 s | **1.12 s** |
| Feed response | 3.31 s | 2.03 s |
| First row (`content-ready`) | 3.99 s | 3.54 s |
| LCP | 4.20 s | 3.71 s |
| FCP | 2.51 s | 1.60 s |
| Feed requests per load | 1 | 1 |

The first row now waits for the boot, not for the network: the page is in hand
~1.5 s before the feed can render it. The FCP difference was not attributed
and may be run-to-run spread in this harness, which is not the one behind the
table above. Bundle: initial JavaScript −285 bytes, total +1,465 bytes.

### Measured startup costs still open (2026-10-15)

- **Alia's live avatar on the home header's Ask Alia button** (`AliaAvatarIcon`,
  drawn by Bloom's character runtime from `alia.onl/bloom-character/`) starts as
  soon as it is visible, ~3.1 s into a cold load, and for a 20 px icon fetches
  **7.8 MiB** in 20 requests (fur, geometry and accessory binaries of 1–2.5 MB
  each) — half of everything `/` downloads in its first 15 s — while the feed
  request and its images are in flight. Blocking it cut home long-task time by
  ~0.75 s (2.22 → 1.47 s) and LCP by ~0.09 s. Its assets are content-hashed but
  served `max-age=0, must-revalidate`. The fix belongs in Bloom's runtime (a
  size-aware level of detail, or a still for icon sizes) and in alia.onl's
  caching, not in Mention.
  **Resolved upstream** by OxyHQ/Alia#791 (immutable caching for the hashed
  assets) and OxyHQ/Alia#792 (SDK 17.1.0 draws a still PNG at icon sizes);
  Mention is on `@alia.onl/sdk` ^21.5.0. Measured on production 2026-10-19: a
  cold load of `/` makes **0 requests / 0 bytes** to the 3D runtime (was 20
  requests / 7.8 MiB). No Mention change was needed.
- **Theme tokens.** Bloom's `BloomThemeProvider` solved the same preset's tokens
  twice on its first render — fixed in Bloom 10.8.2 (OxyHQ/Bloom#361). The
  splash (`AppSplashScreen`) resolves the full DARK token set for one gradient
  stop, which a light-mode device never uses otherwise: Bloom 10.10.0
  (OxyHQ/Bloom#363) adds `getPresetBackground`, the one token for one tone
  solve, and the splash moves to it with that bump. Measured with the Bloom
  build: colour-engine CPU before 2.9 s 143 → 99 ms (4x CPU, 3 profiles each);
  the splash's own share 5 ms. What is left is the ONE light set the theme
  needs (~90 ms at 4x on its first, unwarmed call); precomputing every built-in
  preset instead would ship 64 presets × 2 modes, 40 KB gzip, to every reader.
- **`@oxy.so/contracts` and its zod 3 copy** — 122.8 KB raw, 24.5 KB gzip,
  19.1 KB brotli of `__common`, and ~20 ms of module evaluation at 4x CPU
  (schemas are built when their module loads). Not a fix to make in Mention or
  by moving imports: `@oxy.so/core` validates its responses with these schemas
  at runtime, the startup session path included, and every API namespace is a
  static import of `OxyServices`, so a subpath import reaches the same modules.
  The copy is also the SMALLEST zod there is: the app's own zod 4 would bring
  its locales (~490 KiB) into `__common` with it. The root fix is in the SDK —
  core checking its responses without zod on the client, as `@syra.fm/sdk` 0.18
  does, or namespaces whose schemas load with their first call.
- **Identity crypto** (`@oxy.so/core/crypto`, `@noble/*`, `@scure/bip39`'s
  wordlist, `buffer`, `@oxy.so/protocol`): ~105 KB raw, ~32 KB gzip of
  `__common`. `OxyContext` and core's cold boot (`identitySession`) import it
  statically; a signed-out web reader never signs anything.
- **Module evaluation is diffuse.** ~2,800 modules initialise before first
  paint (~530 ms of factory time at 4x CPU, plus ~280 ms of the Metro
  runtime's own `loadModuleImplementation`): react-native-web ~100 ms, Bloom
  ~90 ms (no family above ~10 ms), expo-router ~70 ms, app code ~60 ms across
  ~460 modules (none above 4 ms). The largest subtree a page does not need is the
  profile chrome under `app/(app)/[username]/_layout.tsx` (~40 ms, evaluated on
  every URL because expo-router requires every layout to build the route
  tree); deferring it would put a chunk round trip in front of every profile.

### Real-browser release gate

`packages/e2e` drives the candidate web build at the production origin
before promotion — see `packages/e2e/README.md`. It is a correctness gate
(cold-boot deadlocks, auth races, search regressions), not a latency budget:
it does not currently assert on timing. Worth knowing before assuming
"there's an e2e gate" implies "there's a performance gate."

## What is instrumented but not held to a budget

`packages/backend/src/utils/metrics.ts` defines a bounded registry —
`http_request_duration_ms` (distribution, labeled by method/route/status),
`feed_ranking_duration_ms`, and real-user `web_vital_lcp_ms` /
`web_vital_inp_ms` / `web_vital_cls_ratio` distributions (fed by
`routes/webTelemetry.routes.ts`). Since 2026-10-17 it publishes to CloudWatch
(`Mention/Backend`) as EMF through `@oxy.so/telemetry/metrics`: one billed metric
per name with `Service` as its only dimension, so CloudWatch keeps SampleCount
and p50/p99 history per metric, and the labels are Logs Insights properties.

### Where a request's time goes: Postgres, or Oxy

Two instrumentations answer the question `http_request_duration_ms` cannot —
*what* a slow route was slow doing. Both attach at a single seam and both
report per request, on the `HTTP request completed` log line that
`middleware/requestObservability.ts` emits:

| Field | Source | Reads |
| --- | --- | --- |
| `queryCount` / `queryDurationMs` | `db/queryMetrics.ts` | Postgres statements issued and time inside them |
| `oxyCallCount` / `oxyDurationMs` | `utils/oxyMetrics.ts` | Oxy API calls issued and time waiting on them |

The line is not written for the readiness probe (`/health/ready`), the uptime
check (`HEAD /`) or the web telemetry beacon (`/telemetry/web`) unless they
answer 5xx; they still feed every metric.

`slowQueryCount` / `failedQueryCount` and `failedOxyCallCount` sit beside them.
The matching histograms — `db_request_queries`, `db_request_duration_ms`,
`oxy_request_calls`, `oxy_request_duration_ms`, plus per-call
`oxy_call_duration_ms` by templated route (its SampleCount is the call count)
— reach CloudWatch too, but only as aggregates; **the log line is the one that
keeps a single request's numbers together**.

Read them together. `postHydrationStatementBudget.test.ts` pins one hydration
at seven statements whether it hydrates one post or twenty, so a route that is
slow with a small `queryCount` is slow somewhere else, and `oxyCallCount` is
where to look first: `PostHydrationService.buildViewerContext` resolves the
viewer's blocked, restricted, following and follower sets live for any caller
that does not thread a pre-resolved `viewerGraph` — which the feed path does
and post detail, notifications, profile and search do not.

**Measured, because that reads like waste and mostly is not.** Threading
`viewerGraph` into search's hydration was implemented and reverted: the Oxy call
count was IDENTICAL before and after, because `buildViewerContext` already
resolves each of the four exactly once per request, so moving the resolution
moved it without removing it. `__tests__/routes/searchOxyCallBudget.test.ts`
pins those counts and is what the reversal left behind. The duplication that IS
real is ACROSS requests — the search screen's "All" tab issues `/search` and
`/posts/saved` separately and each pays the four for the same answers — and only
a combined endpoint resolving the context once can collapse that. One genuine
per-request waste survives and is pinned at its current value: with an
`exclude-following` muted word, `getUserFollowing` is called twice.

**No PRODUCTION baseline numbers are recorded here yet.** The instrumentation
exists; a number belongs in this document only once someone has read it off a
real deployment, and one written from a code trace would be a guess wearing a
measurement's clothes.

The search figures in the section below are the one exception, and they are
labelled as what they are: `EXPLAIN ANALYZE` against a seeded local database of
stated size. That is a real measurement of a QUERY PLAN, which is what changes
when an index is added — but it is not a request p95, it does not include the
network, Oxy, Clarity or hydration, and the data is synthetic. Do not read them
as a service-level baseline; read them as before/after evidence that a specific
plan changed. `OXY_REQUEST_METRICS_ENABLED=false` takes the Oxy half
out of the path entirely (no wrapper, no async context), the same posture as
`DB_QUERY_METRICS_ENABLED`.

### Search: what the plans do now, measured

Before/after `EXPLAIN ANALYZE` on seeded local databases, single backend, sizes
stated. Query-plan evidence, not request latency — see the caveat above.

| Query | Before | After | Data |
|---|---|---|---|
| Oxy people search, rare term | 191.97 ms (seq scan, 200k rows filtered) | **0.026 ms** | 200k users |
| Oxy people search, common term | 71.57 ms (3 parallel workers) | **18.84 ms** | 200k users |
| Oxy people search, 2-char term | seq scan, guaranteed | **19.90 ms** | 200k users |
| `GET /lists?search=`, selective | 59.87 ms (seq scan, 120k filtered) | **0.19 ms** | 120k lists |
| `GET /lists?search=`, unselective | 56.98 ms | 31.36 ms | 120k lists |
| The `count(*)` beside it | 54.07 ms | **0.21 ms** | 120k lists |
| `GET /hashtags/` trending window | 325.79 ms | cached | 400k posts |
| `GET /hashtags/` direction maps (×2) | 63.94 ms each | cached | 400k posts |
| `GET /hashtags/search` and the overview's hashtag lane | 51.50 ms (parallel seq scan — see below) | **1.16 ms** | 500k posts, 200k tagged |

The rare-term row is the one that matters: a sequential scan costs the same
whether it finds nothing or everything, so the old plan charged full price for
the most common outcome of a real search.

Two of these settled arguments rather than just recording wins. The
`count(*)` row is why `total` was KEPT on the list and pack endpoints after
being removed — the count was expensive because the index was missing, so
fixing the index fixed the count. And the hashtag-search row is why the planned
`hashtag_stats` table became a cache — on a measurement that turned out to be
of a hand-written query rather than the one the service ran.

**The hashtag row was wrong until #1140, and how is worth knowing.** The index
is on `posts_hashtags_search_text(hashtags)`, an IMMUTABLE wrapper around
`array_to_string`; the service filtered on `array_to_string(hashtags, ' ')`
directly. Postgres will not inline an IMMUTABLE function whose body is only
STABLE, so the two expressions never matched and every hashtag search — the
Hashtags tab and the `/search/overview` lane alike — read every public tagged
post. Production, 2026-09-11 to 09-25: that statement logged slow 213 times,
**4.3 s median, 17.6 s p90, 35.7 s worst**; `/search/overview` ran 1.57 s at the
median and 10.4 s at worst, and it is the request every search waits on. The
lane's 1 s statement budget did not stop it either, because the lane queries
ran on `getDb()` rather than on the transaction the budget was `SET LOCAL` on.
Both are fixed: the expression is `hashtagsSearchTextSql` on the schema, shared
by the index and the query, and `searchIndexes.test.ts` EXPLAINs the builder's
own statement; `searchOverviewBudget.test.ts` pins that a lane query is
cancelled at its budget and run once.

**The posts search (`GET /search`), the second half of #1140.** With the
overview fixed, signed-in search still took 8–10 s to show People: the All tab
awaited every source, and `/search` ran 3.2 s, 5.0 s and 6.9 s for "rust",
"climate" and "linux" (production, 15:43Z on 09-25). Two causes, both measured:

- The query's best plan depends on how common the word is — newest-first walk
  for a common word, the `search_vector` GIN index for a rare one — but
  postgres.js prepares every statement, and after five executions Postgres may
  cache a GENERIC plan that never sees the word. That plan walks newest-first
  for everything. On 1M seeded posts (warm cache), before → after
  `services/search/postSearch.ts` (`force_custom_plan`, serial, and the
  long-dead `config.search.maxTimeMS` as its `statement_timeout`): "linux"
  1411 → 5.6 ms, "rust" 1088 → 10.2 ms, "climate" 535 → 33.5 ms, "mention"
  62 → 3.7 ms. Pinned by `__tests__/db/postSearchPlan.test.ts`.
- Hydration asked Clarity to wait up to 2 s (`waitMs`) for any link it had
  not resolved yet, which is the ~2 s every production `/search` spent after
  its query. A read no longer waits; posts are warmed at ingest and creation.
  A link Clarity has not finished on that read marks the post
  `documentsPending`, and the app asks `POST /posts/documents` for it a few
  seconds later, off the render path. That endpoint is the only read that
  waits (3 s).

**Then the query itself, cold (#1158).** With the generic plan gone, the posts
statement still took 1.25 s in production with nothing queued ahead of it.
EXPLAIN on production from a one-shot task: the GIN index finds the matching
renditions but cannot order them, and the timestamp lives on `posts`, so the
statement fetched EVERY match and every one of their posts before keeping 21 —
"climate" 3,910 matches, 9,209 buffers read, 6.0 s cold; "hello" 7,109 buffers,
4.6 s; "rust" 4,760, 4.0 s. Warm it was 57–225 ms: the cost was I/O.
`post_content_variants.post_created_at` (a copy of `posts.created_at`, 0048,
backfilled by `scripts/backfillVariantPostCreatedAt.ts`) lets the text match be
bounded by time on the same table, and the search reads windows newest first —
the last day, the week, the month, then the rest — stopping once the page is
full. Inside a window the GIN index and the column's btree meet as a BitmapAnd.
On 1.2M synthetic posts (Zipf vocabulary, 75 days), buffers touched per page:
a "climate"-frequency word (0.4% of posts) 25,317 → 353, a common word (1%)
8,456 → 1,266, a 0.1% word 6,695 → 898 (two windows); a 0.01% word, whose
matches were already few, 540 → 631 (three windows). Each window bounds `posts.created_at`
too; without it an older window was a 1.9M-buffer walk down from now. Pinned by
`__tests__/db/postSearchWindows.test.ts` (rows read are bounded by the window)
and the windowed pagination walk in `__tests__/routes/searchPosts.test.ts`.

The frontend now runs the All tab as one query per source
(`hooks/useSearchAllSources.ts`) and renders each section as it lands —
`__tests__/searchScreenProgressive.test.tsx` holds the posts source open and
asserts People is on screen.

**Retained since 2026-10-17, not yet budgeted.** The registry is published to
CloudWatch as EMF (above), so p50/p99 of every metric now survive the process
that recorded them; per-route percentiles come from the `HTTP request
completed` log line (`oxy-infra` `logs-insights-mention.tf`). No numeric SLO
is enforced against them yet; write one only after a few weeks of history.

This covers every backend path #703 asked for (following/For You/profile
feed, search, post create/update, notifications, ActivityPub inbox and
delivery-queue age, websocket propagation, background worker queue age) in
the sense that request-level latency for anything routed through Express is
already in `http_request_duration_ms` by route label, and feed ranking has
its own histogram. The gap is uniformly the pipeline, not per-path
instrumentation — retaining the registry once unlocks a budget for all of
them at once, rather than needing a bespoke solution per path.

### Web navigation latency

`packages/e2e/perf/nav-latency.mjs` measures how long the app is blank after a
tap, and attributes it. Like `reel-open.mjs` it is a measurement, not a gate:
it prints numbers and never fails.

Measured 2026-09-05 against production, real Chrome on a private Xvfb, signed
out, warm cache, fresh page per run, n=10 (mobile) / n=6 (desktop):

| feed row → `/p/<id>` | cold (first of the session) | hot (second, same page) |
| --- | --- | --- |
| blank frame, p50 | **315 ms** (430x932) / 310 ms (1440x900) | **1 ms** / 2 ms |
| tap → real content, p50 | 332 ms / 321 ms | **13 ms** / 16 ms |

The attribution matters more than the totals: the route chunk is fetched in
**1 ms** from disk cache, **no API call completes inside the blank window**
(the screen paints from the in-memory post cache before `/feed/item/` even
starts), there are **zero long tasks**, and rAF delivers 20 frames at a regular
17 ms cadence through the wait. The main thread is idle and the network is
done — the wait is the first-time resolution of the route module, and the `hot`
column is both the proof and the ceiling.

Absolute numbers here belong to one machine and one network; they are
meaningful against another run of the same harness on the same setup, and
nowhere else.

## Native feed row cost (Jest harness, issue #1103)

`packages/frontend/components/Feed/__perf__/rowCost.perf.tsx`, run with
`bun run --cwd packages/frontend test:perf` and in CI on every frontend change.
It mounts REAL feed rows — `renderFeedRow`, the function both Feed
implementations call — under the real Bloom provider, i18n and React Query.
Only native modules and the network boundary are replaced
(`test-support/perfSetup.ts`); every request a row makes is recorded.

Two kinds of number come out of it, and only one of them gates:

- **Structural, gated** (`__perf__/budgets.json`): element instances, hook
  slots, context reads and host primitives per row kind (hooks and contexts are
  read off React's committed fibers — they are the controllers and store
  subscriptions a row mounts, which an element count cannot see), requests and React Query observers per row, renders
  per mount, re-renders of UNRELATED mounted rows for an unrelated store write /
  a like on another post / a view-count update, and translation requests during
  a 200-post fling (must be zero). These are exact and deterministic. Lower a
  ceiling when an optimization lands; raising one is a decision the PR states.
- **Timing, recorded not gated**: JS ms per row mount and per recycle, median of
  7 runs. Jest on a dev React build, on a machine that may be running other
  work — relative evidence between two runs on the same machine, never device
  frame time.

Since #1115 the harness compiles rows with the React Compiler, as the app
ships them (`jest.perf.config.js` sets `supportsReactCompiler` on the Babel
caller; jest-expo's own caller does not). Numbers before that PR are for the
hand-written hooks; the last column is compiled output.

### Hook slots per row across #1103

Baseline is `main` at a1705141f, before any #1103 change
(`__perf__/results/baseline-main.json`); the current numbers are in
`__perf__/results/latest.json`. node 24, jest-expo ios.

| Row | baseline | #1109 selectors | #1114 lazy machinery | #1112 one controller | #1115 compiled | change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| text | 478 | 498 | 427 | 342 | **291** | −39% |
| image | 645 | 665 | 493 | 408 | **349** | −46% |
| multiImage | 726 | 746 | 574 | 489 | **406** | −44% |
| video | 600 | 620 | 549 | 464 | **402** | −33% |
| linkPreview | 531 | 551 | 480 | 395 | **344** | −35% |
| quote (2 posts) | 826 | 866 | 756 | 586 | **484** | −41% |
| repost | 497 | 517 | 446 | 361 | **310** | −38% |
| poll | 512 | 532 | 461 | 376 | **325** | −37% |
| communityNote | 522 | 542 | 471 | 386 | **335** | −36% |

Context reads per text row went 52 → 39. Element instances and host nodes did
not move: the work removed was hook state, subscriptions and controllers, not
views. What each step did:

- **#1109** removed the whole-store subscription in the four engagement hooks.
  It adds 20 slots (nine per-action selectors where there were four
  selector-less reads) and takes unrelated-write re-renders from 10/10 rows to 0.
- **#1114** mounts the zoom gallery (~100 slots on an image row) on first tap,
  the like burst animation on first like, and drops `useTranslation` from
  `AccountBadge` (which renders nothing for most accounts) and `PostContentText`.
- **#1112** replaces every per-row controller (engagement hooks, overflow-menu
  builder, community-note flows, share, sources/insights wiring) with one
  app-lifetime `usePostInteractions()` controller whose menu is built on press.
- **#1115** removes the reasons the React Compiler was skipping `PostItem`,
  `PostActions`, `PostAttachmentMedia`, `VideoPlayer` and `PollCard`. They were
  skipped on `main` too.

| Isolation (10 mixed rows mounted) | baseline | now |
| --- | ---: | ---: |
| row renders on an unrelated posts-store write | **10** | **0** |
| other-row renders when post A is liked | 0 | 0 |
| other-row renders on a view-count update | 0 | 0 |

A row makes no request of its own. The last one, a prefetch of the author's
avatar, was removed (2026-10-19): the row's `Avatar` asks for the same image in
the same commit, so the prefetch was a second request and ~20 hook slots per
row (text 293 -> 272). A 200-post fling now makes **zero** requests (198 before,
all avatar prefetches) and zero translation requests. Before #1106 the frontend
could auto-translate a row on mount; now only an explicit Translate calls the
endpoint.

Measured outside the row harness, in each PR's own test:

| What | before | after | PR |
| --- | ---: | ---: | --- |
| live-presence Query observers, 50 avatars mounted | 51 | 1 | #1108 |
| avatars re-rendered when one user goes live | 51 | 1 | #1108 |
| video players re-rendered when one more row becomes visible (21 mounted) | 21 | 1 | #1116 |
| video player renders per scroll step (21 mounted) | 42 | 6 | #1116 |
| video players re-rendered when the active player changes | 21 | 2 | #1116 |
| identity edit for user A: rows re-rendered that do not show A | all | 0 | #1107 |
| poll fetches when a poll row remounts or recycles | 1 per mount | 0 (cached per viewer) | #1115 |
| inference calls for N concurrent translate requests (same post and locale, across instances) | N | 1 | #1110, #1113 |

`LinkifiedText` parsing (§11) was measured and **not** optimized, because it is
not material: `scanLinkifyEntities` takes 0.3 µs for a plain 96-character body,
0.5 µs for 1,164 characters and 6.7 µs for 21 entities (Bun/JSC, 20k
iterations). Even at 10× on Hermes that is well under 0.1 ms, against
millisecond row mounts. The cost of an entity-heavy body is the elements it
creates, and those are counted above.

### Release device baseline (#1103)

The Jest harness measures structure; this measures the device. Script:
`packages/frontend/scripts/perf/android-feed-scroll.sh` (release APK, adb). Each
run: cold start, 40 fixed-distance drags (1300 px, 700 ms, no momentum, so every
build scrolls the same distance), then gfxinfo, meminfo and per-thread CPU from
`/proc`; then 24 fast flings with a screenshot during each, scored for blank
rows by `blank-band.py`. Builds were interleaved in the same session so the live
feed was the same for both.

Pixel 8a (Android 16), release `assembleRelease` arm64, signed-out For You feed,
2026-09-30. Median of 3 runs after a discarded warm-up. CPU is in 10 ms ticks
over the 40 drags. "Before" is a1705141f, the commit before #1103's first PR;
"after" is main at bf6eeb66c. Both builds include #1272's anonymous-pagination
fix, which the signed-out fling needs in order to scroll at all:

| | before #1103 | after #1103 |
|---|---:|---:|
| JS thread (`mqt_v_js`) CPU | 1,911 | 1,864 (−2%) |
| UI thread CPU | 1,657 | 1,649 |
| RenderThread CPU | 1,652 | 1,733 |
| Janky frames | 0.28% | 0.35% |
| p90 / p99 frame | 8 / 12 ms | 9 / 13 ms |
| RSS after 40 drags | 829 MB | 862 MB |
| Blank rows during fast flings | 0 / 24 | 0 / 24 |

**The row work did not move the device.** Hook slots per row fell 39–46% in
the harness above, but the JS thread's cost during a scroll is not dominated by
building rows. `simpleperf` (DWARF call graphs) on `mqt_v_js` puts 47.8% of it
in Fabric state updates from the ScrollView, each committing the whole tree
and re-running Yoga layout from the root. Of that, 26% is a recursive
pixel-grid rounding pass, with `fmod` alone at 11% self time. That pass walks
every mounted node on every scroll frame. Rendering and row construction are
the minority. Follow-up: #1280.

Unrelated main changes between the two commits (a Bloom major, stickers) are in
"after" too, so this is main-before vs main-after, not #1103 in isolation.

**Long scroll memory is bounded.** 200 drags (~260,000 px, several hundred
posts) on the after build: RSS 925 → 924 → 1,037 → 1,014 → 996 MB at 40-drag
checkpoints, Java heap flat at 39–41 MB, native heap plateaus at ~288 MB after
120 drags. It levels off rather than growing with every post visited.

### FlashList tuning (Phase 6): measured, kept at 1000

| drawDistance / pool | JS CPU | Janky | RSS | Blank rows (fast flings) |
|---|---:|---:|---:|---:|
| 1000 / 20 (shipped) | 1,864 | 0.35% | 862 MB | 0 / 24 |
| 500 / 20 | 1,836 | 0.48% | 857 MB | 0 / 24 |
| 250 / 20 | 1,888 | 0.41% | 845 MB | 0 / 24 |

Lowering `drawDistance` shows no blank rows on this device, but it buys
nothing measurable either: JS CPU moves less than run-to-run noise, and RSS
moves 5–17 MB. 250 was previously reported as rows arriving late on a slower
build (see the comment on `FEED_DRAW_DISTANCE`), so with no measured gain the
margin stays. `maxItemsInRecyclePool={20}` stays for the same reason: the 8-pool
run was lost to a stuck cold start and not repeated, because the pool has no
lever on the cost that dominates.

Not measured: time-to-visible for a row entering the viewport (the blank-band
score is the proxy), iOS, and a signed-in feed (the device has no identity to
sign in with).

### How to profile a feed regression

1. `bun run --cwd packages/frontend test:perf` — compare
   `__perf__/results/latest.json` with the committed copy. A structural number
   that moved is the regression; the budget gate names it.
2. For a component count that grew, mount the row kind alone
   (`FEED_PERF_RUNS=1`, `it.only`) and diff `renderer.root.findAll` by type
   against `main` — the new wrapper or hook-owning component is in the diff.
3. For a re-render that appeared, the isolation case prints which trigger woke
   unrelated rows; look for a selector-less store read (the
   `validate:feed-hot-path` gate catches the zustand form) or a Context whose
   value changed identity.
4. Timings: only compare two runs on the same idle machine; for frame time,
   use a release build on a device with the React Native profiler.

## What has no instrumentation at all

Native cold start / first-usable-screen timing (iOS and Android), iOS scroll,
and time-to-visible for a row entering the viewport have no measurement in this
repository. Android release scroll (frames, per-thread CPU, RSS, blank rows) is
measured by the device script above, by hand, not in CI: it needs hardware. Web
LCP is covered by the real-user web vitals above.

## Recommended next step, not taken in this pass

Write real p95/p99 budgets against the retained metrics. Since 2026-10-17 the
registry in `utils/metrics.ts` reaches CloudWatch (`Mention/Backend`) through
the shared EMF publisher in `@oxy.so/telemetry/metrics`, so a metric now
survives the process that emitted it. Give it a few weeks of history first — a
number chosen before that would be a guess wearing an SLO's clothes.
