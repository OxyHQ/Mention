// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { APP_COLOR_PRESETS, resolveProfileColor } from '@oxy.so/bloom/color-presets';

/**
 * Returns the hex color for a user's profile color, to be used as
 * the Avatar placeholder background when no avatar image is available.
 */
export function getUserPlaceholderColor(
  user?: { color?: string | null } | null,
): string | undefined {
  const color = resolveProfileColor(user?.color);
  return color?.seed ?? (color?.colorPreset ? APP_COLOR_PRESETS[color.colorPreset].hex : undefined);
}
