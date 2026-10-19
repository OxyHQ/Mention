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
check stays a clean gate instead of a list everyone learns to ignore: today
only Jest 30 with its `@types/jest`. Taking one of those back to the SDK's
version is a downgrade — remove it from the list only when the SDK catches up.
SDK 58 caught up with the others (`@shopify/flash-list`,
`react-native-pager-view`, `react-native-safe-area-context`,
`react-native-svg`), so they left the list with it.

`jest-environment-jsdom` is pinned to 29.7.0 in `packages/frontend`: it is the
environment the `@jest-environment jsdom` test files run in, and jest-expo 58
would otherwise hoist 30. Every test file, jsdom ones included, runs React
Native's jest setup, which redefines `window` on the global, and 30's jsdom
`window` is unforgeable, so those files fail with "Cannot redefine property:
window" before a test runs. 29.7.0 is the version jest-expo 57 resolved.
