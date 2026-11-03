# Dependency updates

Dependabot checks dependencies weekly and groups `@oxy.so/*` releases into one
reviewable pull request. A Dependabot npm PR is a notification in this Bun
workspace: adopt it on a branch, regenerate `bun.lock`, and run the normal test
and typecheck gates before merging.

`bun run doctor:oxy` is read-only. It verifies that direct Oxy dependencies are
current and that the lockfile has no duplicate Oxy versions; CI never rewrites
the manifest, installs `latest`, or updates dependencies at application startup.

## Expo-managed versions

Native modules the Expo SDK pins (its bundled native-module list) move with
the SDK: bump `expo`, then let `npx expo install --check` in `packages/frontend`
name the versions. A few are deliberately AHEAD of what the SDK names and are
listed in `expo.install.exclude` in `packages/frontend/package.json`, so the
check stays a clean gate instead of a list everyone learns to ignore. Today
that is Jest 30 with its `@types/jest`, and the patch releases SDK 58.0.23
still names one behind: React and React DOM 19.3.1 (the SDK names 19.3.0),
`@shopify/flash-list` 2.3.3, `react-native-gesture-handler` 3.4,
`react-native-keyboard-controller` 1.22.9, `react-native-pager-view` 9.0.11 and
`react-native-worklets` 0.13.1. Taking one of those back to the SDK's version
is a downgrade — remove it from the list only when the SDK catches up.
`expo-gl` is listed the other way round: it stays on 58.0.3, one patch behind
the SDK's 58.0.4, because `@oxy.so/bloom-avatar-native` peers exactly 58.0.3
and any other version installs a second copy of the native module beside it.

`jest-environment-jsdom` is pinned to 29.7.0 in `packages/frontend`: it is the
environment the `@jest-environment jsdom` test files run in, and jest-expo 58
would otherwise hoist 30. Every test file, jsdom ones included, runs React
Native's jest setup, which redefines `window` on the global, and 30's jsdom
`window` is unforgeable, so those files fail with "Cannot redefine property:
window" before a test runs. 29.7.0 is the version jest-expo 57 resolved.

## Held back

Each of these is behind its latest release for a reason outside this repo;
move it when the reason goes away.

- `typescript` stays on 6.0: typescript-eslint (the frontend's `expo lint`)
  peers `typescript <6.1.0`, and TypeScript 7.0's package exports no compiler
  API for it to load.
- `postgres` stays on 3.4: `@oxy.so/db` peers `postgres ^3.4.9`.
- `@react-native-async-storage/async-storage` stays on 2.x: `@alia.onl/sdk`
  peers `^2.2.0` (`@oxy.so/core` 7.14, `@oxy.so/services` 14.3 and
  `@oxy.so/protocol` 1.6 already accept 3).
- `react-native-audio-api` stays on 0.13: `@alia.onl/sdk` peers `^0.13.6`.
- `@peable.to/sdk` stays on 0.8.0: `@oxy.so/services` depends on exactly that
  version, and the app must load one Peable copy.
- `nativewind` 5.0.0-rc.0 and `react-native-css` 3.1.0-rc.0: `@oxy.so/bloom`
  depends on `react-native-css` 3.1.0-rc.0 exactly and peers `nativewind`
  `>=5.0.0 || 5.0.0-rc.0`.
- `metro` and its packages stay on 0.87.1: `@expo/metro` 58.0.0 pins Metro
  0.87.1 exactly, and Metro 0.87.2 calls `addRoot()` on the file map, which
  Expo's `@expo/metro-file-map` does not have (`expo export` fails with
  `this._haste.addRoot is not a function`).
- `lightningcss` stays on 1.30.1: `react-native-css` 3.1.0-rc.0 still fails
  native bundling on 1.33.0 with "failed to deserialize; expected an
  object-like struct named Specifier".
- `jest-environment-jsdom` stays on 29.7.0 (above).

ESLint is on 10 although `eslint-plugin-react` (7.37.5, its latest) still
declares `^9.7`: the only ESLint 10 break is its React version detection, so
`eslint.config.js` states the installed React version instead of `'detect'`,
and every `react/*` rule the config enables reports on ESLint 10.
`eslint-plugin-expo` 1.2.1 (its latest) lists `eslint ^9.24.0` as a dependency,
not a peer, so bun nests an ESLint 9 copy under it; the lint run itself uses
the root ESLint 10.
