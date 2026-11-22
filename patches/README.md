# Expo Router 58.0.30

The experimental stack currently ignores `contentStyle` and hardcodes a white
scene. Mention's Bloom AppShell owns the central surface, including its scoped
profile color. The router patch removes that competing fill and keeps its
existing `headerShown` correction. Transparency only affects the navigator
wrapper: the stack's `screenLayout` (`components/navigation/StackScene.tsx`)
paints every screen with the panel's own fill, so no screen shows the one under
it through itself.
The npm package ships the compiled implementation, not its TypeScript source.
Remove this hunk when upstream supports transparent scene styling. Both hunks
are still needed in 58.0.30 (it keeps `backgroundColor: 'white'` and renders
`StackV5.HeaderConfig` unconditionally); the patch was re-made against it. The
two 57.0.23 hunks for pending deep-link state (`useOnGetState`,
`findMatchingState` in `fork/useLinking`) are gone: SDK 58 replaced that
navigation core and neither function exists any more. The cold deep-link
browser gate (`packages/e2e/tests/deep-link-boot.spec.ts`) still covers the
behaviour. This does not claim physical-device validation: verify Android rendering
after installation.

The same patch carries the predictive Back ownership backport, the seeded-params
forwarding and navigator-state retention (`docs/audits/2026-10-31-predictive-back`).
Forwarded from 58.0.24 to 58.0.30 unchanged except one merge: 58.0.30 wraps the
container's provider tree in its new `CanGoBackContext`/`CanDismissContext`, and
`BaseNavigationContainer.js` now nests that tree inside the backport's
`NativeBackRegistryContext`/`NavigationActionResultRegistryContext`. The two
compiled source maps upstream regenerated for 58.0.30
(`BaseNavigationContainer.js.map`, `createSeededNavigationState.js.map`) are
left as published: npm ships no TypeScript source to rebuild them from, so in
those two files the patched lines map to the nearest upstream line. The native
predictive Back gates (source-built opted and default APKs, device acceptance)
were not repeated for this forward.

`fork/getStateFromPath.js` builds the route table once and sorts it once per
location. Upstream rebuilt it on every call: every route's normalized config,
its regex and the sort ("config resources depend on the current state"). Only
the order depends on the current segments (the sorter prefers the routes they
name), so the configs and regexes are built once per options and sorted once per
segments. Bloom's tab pager is a `useTabsWithTriggers` layout, which resolves
each tab's href through `getStateFromPath` on every render, and it renders on
every navigation, a pushed post included: on the Pixel 8a the rebuild was 90 to
210 ms of each tab switch, post open and Back, and a rebuild once per navigation
still 25 ms (Hermes sampling profiles, 2026-11-22). Results match upstream's for
the same options, path and segments. Remove the hunk when upstream caches the
route table.

# expo-video 58.0.13

The web player calls `video.play()` and drops the returned promise, so two
rejections that are not failures of the call surface as unhandled rejections:
removing, pausing or replacing media cancels a pending play (`AbortError`), and
a source the browser cannot load rejects it with `NotSupportedError`. That
second one is already reported: the element's `error` event sets the player's
status to `error`, which `VideoPlayer` renders as "video unavailable", the same
state as any broken or missing media. The patch routes every call through
`playVideo()`, which consumes exactly those two and rethrows anything else.
Still present in 58.0.13 (all five calls); re-made against it. Remove when
upstream handles the `play()` promise.

On Android, `VideoView` lays out its `PlayerView` only after a `requestLayout`.
React Native resizes a view by setting its frame, which never measures it, so a
view moved to a new frame kept the player at its old measured size. Bloom's
media flight carries one video node from a feed card into the reel, and the
reel drew the video at the card's size, centered and small. The patch measures
and lays out the player in `onSizeChanged`. Expo links its modules as
precompiled AARs, so `packages/frontend/package.json` builds expo-video from
source (`expo.autolinking.android.buildFromSource`), or the patch would never
reach the APK. Remove both when upstream re-lays out the player on a frame change.

# react-native-screens 4.30.1

The experimental ("gamma") stack host lays its native `StackContainer` out with
the host's own bounds in its PARENT (`container.layout(l, t, r, b)`), where a
child takes coordinates in the host's space. Whenever the stack does not sit at
its parent's origin, the whole navigator is offset by the host's position a
second time. Mention's stack sits inside Bloom's AppShell panel (below the
header, inside the gutter), so on Android every screen started 110 dp lower and
8 dp further right than the panel — a blank band under the header and a double
frame. The patch lays the container out at `(0, 0, width, height)`. Measured on
a Pixel 8a release build: the container moves from (42, 578) to the panel's own
(21, 289). Still present in 4.30.1 (Expo Router 58's `ExperimentalStack` still
renders this host); remove when upstream
fixes `StackHost.onLayout` / `layoutContainerNow`.

The same stack adds every pushed screen over the last one and never removes the
screen it covers from the view tree, so the RenderThread prepared and drew every
screen of the stack each frame under the top one. On a Pixel 10 Pro release
build, scrolling a profile went from 0.9% janky frames (p50 8 ms) to 27% (p50
21 ms) after 20 pushed screens. The patch is a backport of upstream's fix,
software-mansion/react-native-screens#4633 (5.0.0-alpha.4): the push transaction
detaches the covered screen, and the top fragment is resolved from the stack
model. Popping the record (Back, predictive back, a JS pop) re-attaches it.
This hunk can go at react-native-screens 5 (5.0.0-beta.1 has #4633); the others
cannot, and 5.x moved these files, so the rest would have to be re-made there.

A root replacement pops the stack's only screen. Upstream refuses that
(`check(stackModel.size > 1)`), because the root was never added to the
FragmentManager's back stack. The patch allows it only when a push is pending,
and removes the old root directly (`RemoveOp`) instead of popping a back-stack
record, so Back cannot reveal the replaced screen. Still upstream's check in
5.0.0-beta.1.

The rest is the native half of predictive Back ownership
(software-mansion/react-native-screens#5118, still open): `BackPressInterceptor`,
`PreventNativeDismissCallback` and a `JavaScriptBackInterceptor` factory that
`StackScreenFragment` installs. `android/build.gradle` compiles the native
adapter only when the `rnscreens.nativeBackOwnershipEnabled` Gradle property is
`true` (Bloom's config plugin writes it for `predictiveBack: true` in
`app.config.js`) and the inert default otherwise, so a build without the React
Native ownership API below still compiles. Remove it when #5118 ships. The
provenance and native gates are in
`docs/audits/2026-10-31-predictive-back/source-validation.md`.

# @shopify/flash-list 2.3.3

`stickyHeaderConfig.offset` does two things. It sets where a stuck header sits,
and it also puts a zero-height measuring view with `marginTop: offset` in front
of the list content, which pushes every row down by the offset. FlashList
documents the offset for a fixed bar ABOVE the list. Bloom's composition for a
native list BEHIND an overlaying `PageHeader` (docs `page-header.mdx`, "Banner
and docked tabs"; `layout.mdx`) passes `useHeaderDockInset()` as that offset, so
the tab strip docks under the header. The push then starts the list below the
header too, and a profile's banner can never reach behind the status bar and
notch.

The patch drops the `marginTop`, so the offset only places the stuck header.
FlashList's sticky math already accounts for the offset
(`findCurrentStickyIndex(…, scroll + offset)`, `top: offset`), so a header still
sticks exactly at the header's bottom edge.

Measured on a Pixel 8a release build:
- Before: the list content started at y=268 (the 121 px status bar plus the
  147 px bar), under an opaque band.
- After: the banner starts at y=0 behind the status bar, and the header is
  transparent at rest.
- The Posts, Media and Likes tabs all dock their strip under the header.

In Mention only the profile passes a non-zero offset: `useHeaderDockInset()` is
0 outside its `HeaderDockProvider`. Present since `offset` was introduced in
2.2.0, and still in 2.3.3. Remove the patch when FlashList separates the sticky
offset from a content inset.

# react-native-gesture-handler 3.4.0

Gesture Handler reaches Reanimated through `reanimatedWrapper.js`, which loads it
with `require('react-native-reanimated')` inside a `try` (Reanimated is an
optional peer upstream). A CommonJS `require` hands the bundler the whole
module, so Metro's tree shaking (`EXPO_UNSTABLE_TREE_SHAKING`, the web export)
has to keep EVERY Reanimated export: all ~100 layout-animation presets (Zoom,
Flip, Bounce, Rotate, Lightspeed, Roll, Stretch, Pinwheel, …), the screen
transitions and the rest, none of which Mention or Bloom uses, in the startup
`__common` chunk of every page load.

The patch imports by name the members Gesture Handler reads (the v3 API
reads more of them than 2.32 did: `isSharedValue`, `NativeEventsManager`,
`setGestureState`, `useComposedEventHandler`, `useEvent`, `useHandler`,
`useSharedValue` and the default export's `createAnimatedComponent`).
Worklets keeps its upstream optional `require`. Mention always installs Reanimated, so the
optional-peer fallback has nothing to fall back from. Only `lib/module` is
patched: it is what the web export resolves, and native bundles are not tree
shaken. Measured on one `expo export --platform web` of the same commit:
`__common` −230,769 bytes raw (4,590,570 → 4,359,801), −25.8 KB gzip;
`react-native-reanimated` in `__common` 722 → 500 KiB (layout animations
241 → 101 KiB; what stays is Reanimated's own web layout-animation runtime,
which every animated component imports, and the Fade and Slide presets Bloom
and the app use). Still `require()` in 3.4.0, which reads the same members.
3.4.0 also probes Reanimated's `AnimatedComponent` with
`require('react-native-reanimated/src/…')`. Metro resolves the package itself
to `lib/module` on web, so that `src` path brought a second copy of
Reanimated's source tree into `__common` (+501 KB raw, +88 KB gzip of initial
JavaScript). The patch points the probe at
`lib/module/createAnimatedComponent/AnimatedComponent`, the same build the
import above loads; the probe's answer is unchanged (Reanimated 4.7.1 has no
`_refreshComponentRef` in either build). Remove the patch when upstream
imports Reanimated statically. 3.5.0 still `require()`s Reanimated, and it moved
the `src` probe to `handlers/gestures/GestureDetector/refreshesAnimatableRef.js`,
so moving to 3.5.0 means re-making both hunks there.

# react-native 0.88.1

The React Native half of predictive Back ownership, from the draft upstream PR
react/react-native#59712 (closed unmerged; not in 0.89). `BackHandler` gains a
public ownership API (`setNativeNavigationEnabled`, with its Flow and TypeScript
types), backed on Android by `BackNavigationCoordinator` in `ReactActivity` and
a new `DeviceEventManagerModule` method. That method changes the native ABI,
which is why `app.config.js` builds React Native from source
(`buildReactNativeFromSource`). Remove it with the Expo Router and Screens
ownership backports, when upstream ships an equivalent.

The `hermes-engine/build.gradle.kts` hunk backports react/react-native#59589:
0.88's Hermes archive extraction assumed an obsolete repository prefix, which
breaks the from-source build. It is in 0.89 (rc.0 onwards), so it can go when
Mention moves to 0.89.

Provenance and the native gates:
`docs/audits/2026-10-31-predictive-back/source-validation.md`.

# react-native-css 3.1.0-rc.0

Backport of [nativewind/react-native-css#511](https://github.com/nativewind/react-native-css/pull/511).
Metro serializes compiled stylesheets as JSON: an omitted `color-mix` percentage
inside an array becomes `null`. The native runtime previously left that slot
unconsumed, rejected the remaining arguments, and discarded valid colors such as
Tailwind `text-white/50`. On a Pixel 8a camera this painted inactive mode labels
black. Consume the omitted percentage placeholder and retain the CSS complementary
weight calculation. The source and both published JS builds carry the same fix;
installed CJS/ESM regression tests use the real compiler's serialized descriptors.

#511 was closed unmerged. Upstream fixed the same bug in the compiler instead
(nativewind/react-native-css#579): `parseColorMix` drops the omitted argument,
so the runtime never receives a `null`. That fix is not in 3.1.0-rc.1, only in
nightlies so far. Remove the patch at the first release that includes #579.

The root `overrides` pins react-native-css to 3.1.0-rc.0 while
`packages/frontend/package.json` asks for 3.1.0-rc.1; rc.0 is what installs, and
this patch is keyed to it.

# lottie-react-native 7.5.0

On Android, a playing LottieAnimationView asks for a redraw on every vsync, so a
looping sticker redraws at the panel's rate (120 Hz on a Pixel 8a) although its
animation has 30 or 60 frames a second. Measured on Mention's empty Notifications
page (the frog sticker), the page rendered about 130 frames a second at rest. The
patch turns on Lottie's own `setUseCompositionFrameRate(true)` for every view the
module creates, so a view redraws only when the animation's frame changes. Bloom's
web Sticker already plays at the animation's own frame rate (`docs/sticker.mdx`).
Remove this patch if lottie-react-native exposes the setting as a prop (then set
it from Bloom's native Sticker player) or makes it the default.
