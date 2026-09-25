# Expo Router 57.0.18

The experimental stack currently ignores `contentStyle` and hardcodes a white
scene. Mention's Bloom AppShell owns the central surface, including its scoped
profile color. The router patch removes that competing fill and keeps its
existing `headerShown` correction. Transparency only affects the navigator
wrapper: the stack's `screenLayout` (`components/navigation/StackScene.tsx`)
paints every screen with the panel's own fill, so no screen shows the one under
it through itself.
The npm package ships the compiled implementation, not its TypeScript source.
Remove this hunk when upstream supports transparent scene styling. This does not
claim physical-device validation: verify Android rendering after installation.

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
