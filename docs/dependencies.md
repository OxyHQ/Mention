# Dependency updates

Dependabot checks dependencies weekly and groups `@oxy.so/*` releases into one
reviewable pull request. A Dependabot npm PR is a notification in this Bun
workspace: adopt it on a branch, regenerate `bun.lock`, and run the normal test
and typecheck gates before merging.

`bun run doctor:oxy` is read-only. It verifies that direct Oxy dependencies are
current and that the lockfile has no duplicate Oxy versions; CI never rewrites
the manifest, installs `latest`, or updates dependencies at application startup.
