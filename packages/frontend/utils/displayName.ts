// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Identity-resolution policy: the entity's display name when it has one (after
 * trimming), otherwise the supplied handle/username fallback.
 *
 * Centralizes the "display name else handle" coalesce that is otherwise repeated
 * across profile, feed, picker, and notification surfaces, so every site applies
 * the exact same rule. The fallback target stays caller-supplied (some sites use
 * `username`, some `@handle`, some another name) — this helper only owns the
 * `displayName?.trim() ||` part.
 */
export function displayNameOrHandle(
  displayName: string | null | undefined,
  fallback: string,
): string {
  return displayName?.trim() || fallback;
}
