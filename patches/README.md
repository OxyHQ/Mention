# Expo Router 57.0.23

The experimental stack currently ignores `contentStyle` and hardcodes a white
scene. Mention's Bloom AppShell owns the central surface, including its scoped
profile color. The router patch removes that competing fill and keeps its
existing `headerShown` correction. Transparency only affects the navigator
wrapper: the stack's `screenLayout` (`components/navigation/StackScene.tsx`)
paints every screen with the panel's own fill, so no screen shows the one under
it through itself.
The npm package ships the compiled implementation, not its TypeScript source.
Remove this hunk when upstream supports transparent scene styling. Both hunks
are still needed in 57.0.23 (it keeps `backgroundColor: 'white'` and renders
`Stack.HeaderConfig` unconditionally); the patch was re-made unchanged against
it. This does not claim physical-device validation: verify Android rendering
after installation.

# expo-video 57.0.5

The web player calls `video.play()` and drops the returned promise. Removing,
pausing or replacing media cancels a pending play, and the browser rejects it
with an `AbortError` that surfaces as an unhandled rejection. The patch routes
every call through `playVideo()`, which consumes only that expected
cancellation and rethrows anything else. Still present in 57.0.5; re-made
unchanged against it. Remove when upstream handles the `play()` promise.

# react-native-screens 4.26.2

The experimental ("gamma") stack host lays its native `StackContainer` out with
the host's own bounds in its PARENT (`container.layout(l, t, r, b)`), where a
child takes coordinates in the host's space. Whenever the stack does not sit at
its parent's origin, the whole navigator is offset by the host's position a
second time. Mention's stack sits inside Bloom's AppShell panel (below the
header, inside the gutter), so on Android every screen started 110 dp lower and
8 dp further right than the panel — a blank band under the header and a double
frame. The patch lays the container out at `(0, 0, width, height)`. Measured on
a Pixel 8a release build: the container moves from (42, 578) to the panel's own
(21, 289). Still present in 4.28.0 and the 4.29 nightly; remove when upstream
fixes `StackHost.onLayout` / `layoutContainerNow`.

# react-native-reanimated 4.5.1

On React Native 0.86+, Reanimated applies synchronous prop updates by calling
RN's internal `MountingManager.updatePropsSynchronously` through reflection. RN's
public path (`FabricUIManager.synchronouslyUpdateViewOnUIThread`) first checks
`getViewExists(tag)`; the reflective call skips that check, so every animation
frame that still targets a view the stack just unmounted throws
`RetryableMountingLayerException` and logs it with a ~150-frame stack. Measured
on a Pixel 8a release build: 45–116 warnings per screen pop, 3,079 in 45 minutes
(#1126). The patch restores RN's check and is byte-for-byte upstream PR
software-mansion/react-native-reanimated#10435 (issues #10280, #10434). Still
present in 4.7.0; remove it with the first release that includes that PR.

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
