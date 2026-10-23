# Expo Router 58.0.24

The experimental stack currently ignores `contentStyle` and hardcodes a white
scene. Mention's Bloom AppShell owns the central surface, including its scoped
profile color. The router patch removes that competing fill and keeps its
existing `headerShown` correction. Transparency only affects the navigator
wrapper: the stack's `screenLayout` (`components/navigation/StackScene.tsx`)
paints every screen with the panel's own fill, so no screen shows the one under
it through itself.
The npm package ships the compiled implementation, not its TypeScript source.
Remove this hunk when upstream supports transparent scene styling. Both hunks
are still needed in 58.0.24 (it keeps `backgroundColor: 'white'` and renders
`StackV5.HeaderConfig` unconditionally); the patch was re-made against it. The
two 57.0.23 hunks for pending deep-link state (`useOnGetState`,
`findMatchingState` in `fork/useLinking`) are gone: SDK 58 replaced that
navigation core and neither function exists any more. The cold deep-link
browser gate (`packages/e2e/tests/deep-link-boot.spec.ts`) still covers the
behaviour. This does not claim physical-device validation: verify Android rendering
after installation.

# expo-video 58.0.12

The web player calls `video.play()` and drops the returned promise, so two
rejections that are not failures of the call surface as unhandled rejections:
removing, pausing or replacing media cancels a pending play (`AbortError`), and
a source the browser cannot load rejects it with `NotSupportedError`. That
second one is already reported: the element's `error` event sets the player's
status to `error`, which `VideoPlayer` renders as "video unavailable", the same
state as any broken or missing media. The patch routes every call through
`playVideo()`, which consumes exactly those two and rethrows anything else.
Still present in 58.0.12 (all five calls); re-made against it. Remove when
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

# react-native-screens 4.30.0

The experimental ("gamma") stack host lays its native `StackContainer` out with
the host's own bounds in its PARENT (`container.layout(l, t, r, b)`), where a
child takes coordinates in the host's space. Whenever the stack does not sit at
its parent's origin, the whole navigator is offset by the host's position a
second time. Mention's stack sits inside Bloom's AppShell panel (below the
header, inside the gutter), so on Android every screen started 110 dp lower and
8 dp further right than the panel — a blank band under the header and a double
frame. The patch lays the container out at `(0, 0, width, height)`. Measured on
a Pixel 8a release build: the container moves from (42, 578) to the panel's own
(21, 289). Still present in 4.30.0 (Expo Router 58's `ExperimentalStack` still
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
Remove when Mention moves to react-native-screens 5.

# @oxy.so/bloom 6.2.0

`SettingsModal` ignored a close requested before its enter frame: `show()`
mounts, and a double `requestAnimationFrame` later sets it visible, so Escape
pressed the moment the panel appeared set `visible` to false (it already was)
and the pending frame then opened it anyway. The release gate
(`packages/e2e/tests/deferred-chunks.spec.ts`) presses Escape right after the
lazily loaded settings dialog appears, and the dialog never closed, which
blocked every web deploy. The patch is the upstream fix, OxyHQ/Bloom#250,
applied to `src`, `lib/module` and `lib/commonjs`: the modal tracks whether it
is wanted open, a close cancels the pending enter frame, and a modal closed
before it was ever shown unmounts at once. Remove it when Mention moves to a
Bloom release that includes #250.

# @shopify/flash-list 2.3.2

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
2.2.0, and still in 2.3.2. Remove the patch when FlashList separates the sticky
offset from a content inset.

# react-native-gesture-handler 3.3.0

Gesture Handler reaches Reanimated through `reanimatedWrapper.js`, which loads it
with `require('react-native-reanimated')` inside a `try` (Reanimated is an
optional peer upstream). A CommonJS `require` hands the bundler the whole
module, so Metro's tree shaking (`EXPO_UNSTABLE_TREE_SHAKING`, the web export)
has to keep EVERY Reanimated export: all ~100 layout-animation presets (Zoom,
Flip, Bounce, Rotate, Lightspeed, Roll, Stretch, Pinwheel, …), the screen
transitions and the rest, none of which Mention or Bloom uses, in the startup
`__common` chunk of every page load.

The patch imports by name the members Gesture Handler reads (3.3.0's v3 API
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
and the app use). Still `require()` in 3.3.0; remove the patch when upstream
imports Reanimated statically.

# react-native-css 3.1.0-rc.0

On native, NativeWind's Metro resolver sends every `import … from 'react-native'`
outside React Native itself to `react-native-css/components`, a shim that
re-exports a fixed list of React Native APIs. React Native 0.88 added
`AssetRegistry` to its public index, and Expo SDK 58's `expo-asset` imports it
from there. The shim does not list it, so `expo-asset` received `undefined`.
Every `useFonts` call then failed with `Cannot read property 'getAssetByID' of
undefined`. Bloom never finished loading its fonts, and Android release builds
stayed on a blank screen. The patch adds the missing getter to `src`,
`dist/module` and `dist/commonjs`. It is still missing in 3.0.7, 3.1.0-rc.0 and
the current nightly. Remove the patch when upstream re-exports `AssetRegistry`.
