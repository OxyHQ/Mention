# Predictive Back source validation

Physical acceptance remains pending; these checks establish source and build
compatibility, not gesture appearance on a device. The completed Mention app
gates below describe the first diagnostic candidate (base `f1217ce96`, Bloom
`.2`, and the RNS backport before the public build capability marker). The
integration has since rebased onto `49a7e789b`; the updated shared packages and capability contract are now installed. Current
rebase validation is recorded separately below; final official-package and device
acceptance remain required.

## Dependency provenance

- React Native: upstream source `937d913770a85ffd05edc6e73ded9129188edd31`,
  [draft PR #59712](https://github.com/react/react-native/pull/59712).
  The version-pinned `react-native@0.88.0.patch` adds the public ownership API,
  Android implementation and generated public types. The app uses the official
  `expo-build-properties` Android `buildReactNativeFromSource` option because the
  added TurboModule method requires a rebuilt native ABI.
- Expo Router: source `d9904291`,
  [draft PR #52680](https://github.com/expo/expo/pull/52680).
  The combined `58.0.24` patch preserves Mention's previous header, seeded-params
  and navigator-retention changes. Runtime JavaScript and declarations were built
  from the exact release source with Expo's compiler, then checked against a fresh
  npm package with the patch applied.
- React Native Screens: [draft PR #5118](https://github.com/software-mansion/react-native-screens/pull/5118).
  The `4.30.0` patch preserves Mention's root-replacement changes and adds an
  explicitly enabled native ownership adapter. Default builds use an adapter
  that does not depend on the new React Native API.
- Bloom: [draft PR #553](https://github.com/OxyHQ/Bloom/pull/553). Diagnostic
  archives are temporary validation inputs. Final integration must use the
  official registry release produced by protected CI.

The Bloom config plugin requires the React Native source-build option before
setting its native opt-in properties. Runtime activation additionally checks the
actual native host and router capabilities, preserving older binaries and web.
A native rebuild is required to activate this feature. React Native, Expo Router
and React Native Screens use exact versions while these backports are required.
An upgrade must explicitly forward or retire each ownership backport and repeat
the default/opted native gates; a semver-range refresh must not silently omit it.

## Completed checks

- React Native: seven JavaScript behavior tests; mutations that count delegated
  navigation as a blocking listener or reorder subscriptions fail the relevant
  tests. The restored implementation passes. Generated TypeScript validation and
  ESLint pass.
- React Native: actual source Release Kotlin and Java compilation passes. Seven
  native tests pass with no skipped tests: four coordinator tests and three
  module ownership/lifetime tests, using the source-built framework.
- Mention: frontend TypeScript passes. Thirteen focused tests pass across
  navigation scope, predictive configuration and seeded route params. Removing
  the active session from the scope key makes its regression test fail; restoring
  the implementation passes.
- Mention: the production optimized web export and font/layout preloading pass
  with diagnostic Bloom `15.79.0-predictive.20261031.2`.
- Mention: the full frontend run passed 416 suites (3,255 tests); four cases
  in the remaining shell-context suite exposed an incomplete session-authority
  test mock. After updating that mock, all four pass on the focused rerun.
- Mention: clean dependency installation and frozen-lockfile installation pass
  with the combined diagnostic dependency set. Production Android prebuild emits
  both native opt-in properties and `enableOnBackInvokedCallback="true"`.

## Native integration findings

The first complete arm64 APK attempt built and linked React Native and Hermes
from source and compiled Bloom's opted-in Release Kotlin successfully. It then
caught a React Native Screens source-selection defect: both the default and
native interceptor factories reached Kotlin compilation, causing conflicting
overloads. The APK was not produced. The corrected version-pinned backport excludes
the inactive file from the public KotlinCompile task inputs. Inspection of the
actual installed task passes for both modes: precisely the native adapter when
enabled and precisely the default adapter otherwise. The full opted arm64 build then passed, including Release Kotlin, native linking,
R8, release lint and normal ecosystem signing. Device acceptance remains pending
because unrelated browser test activity appeared during the initial device
preflight; input is paused until exclusive control is confirmed.

## Local build prerequisites and transport

The source build uses Android platform `platforms;android-37.0`, Build Tools
37.0.0, NDK 27.1.12297006 and CMake 3.30.5. Mention's resolved AndroidX Activity
version is 1.11.0. No SDK downgrade is used.

React Native 0.88's Hermes archive extraction assumes an obsolete repository
prefix. The patch also backports the repository-independent extraction from
[upstream PR #59589](https://github.com/react/react-native/pull/59589), commit
`f6a5042c8445c29d169a8b0a641fdd5e47794ecd`. The Hermes version remains
`hermes-v260318099.0.2` (tag commit
`4188b63f24026ca62b79dc81d95db122a59c6089`).

This environment's Java HTTP client could not fetch valid release URLs. Exact
upstream archives were downloaded with curl, hash-verified, and supplied via
`REACT_NATIVE_DOWNLOADS_DIR`. A local init script verifies those hashes and skips
only the already-completed HTTP download tasks. Normal extraction, codegen,
CMake, compilation and testing still run. TLS validation was not disabled.
Robolectric's exact Android 13 instrumented jar was likewise verified against
Maven Central's SHA-512 before using its supported offline dependency directory.
These local transport scripts are not production build configuration.

The host Hermes compiler needs ICU. Official Debian 76.1-4 packages were checked
against repository metadata and extracted into a task-local sysroot, supplied
through `ICU_ROOT` and `CMAKE_PREFIX_PATH`. This host prerequisite is not packaged
as an Android library.

AGP invokes Ninja directly, so Gradle worker limits alone do not bound native
compiler concurrency. The local build adds CMake compile/link pools of four and
one jobs respectively. Generated Ninja rules and live compiler processes were
checked to verify these limits. These arguments change AGP's CMake cache key;
existing object files are not copied between configurations.

The React Native/Hermes release source build also passes for both existing
production architectures, `armeabi-v7a` and `arm64-v8a`. The exact patched
React Native Screens 4.30.0 package compiles with its default ownership adapter,
in addition to the opted build and both actual Kotlin input-selection checks.

## Diagnostic artifact

The signed arm64 diagnostic APK has SHA-256
`d3d972ed1c36d4b3fa49409d04e49387477a4a2aa5484e58e6729eaaa2234dbf`.
Its ecosystem signer is
`b8ab3746466ce4569d7a6a0ffa1eed91bc375174d503613987ca09cb33d6a58d`.
The manifest enables predictive Back, uses package `earth.mention.app`, targets
Android API 36 and requires API 24. Installation with replacement preserved app
data on a Pixel 8a running Android 16. This is a diagnostic artifact, not final
production acceptance. The existing release architecture set remains
`armeabi-v7a,arm64-v8a`.

## Current-main diagnostic validation

The second integration uses Mention base `49a7e789b`, Oxy Core 7.9.1, Services
13.13.0, and Bloom `15.81.0-predictive.20261031.4`. Its immutable Bloom source is
`0cef99bfffb8280c4611e0fa5d640542e50e6a26`, retained on
`OxyHQ/Bloom:archive/predictive-diagnostic-4`. The diagnostic archive SHA-256 is
`7684c12422924c82c279c1877bf422c8c8dea14b43ca0d630bc1949b3df7d05d`.

- Installation and frozen-lockfile installation pass.
- Frontend TypeScript passes; all 418 suites and 3,290 tests pass in one run.
- Actual installed Gradle capability values pass in both modes: immutable
  `apiVersion: 1` with the matching Boolean `enabled`. Kotlin compiler input
  selection includes exactly the corresponding native or default adapter.
- Both paired default and opted configurations compile Bloom and the exact RNS
  backport against the source-built React Native framework.
- Deliberately enabling Bloom while disabling RNS ownership fails configuration
  with the expected actionable error, before compilation.

The new SDK also preserves ordinary JS Back ownership without a native pager.
A native host lacking a drawable destination consumes a guarded ordinary Back
without translating the current surface against a blank preview. These cases
have shared-library regression coverage; they do not substitute for physical
gesture acceptance.

The current-main `.4` signed app also builds with the complete existing release
architecture list. The APK contains both `armeabi-v7a` and `arm64-v8a` libraries
and its ecosystem signature verifies. Its SHA-256 is
`df0dbf04b70a69b253811799c47eece1413a835fee7339c6406d32534b507814`. It has not been installed while device control is paused.
