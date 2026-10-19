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
