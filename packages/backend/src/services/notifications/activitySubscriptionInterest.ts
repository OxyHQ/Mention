// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { RankingUserBehavior } from '../feed/ranking/signalContext';

/** Negative author choices override a bell; this does not alter post access. */
export function eligibleActivitySubscriptionAuthors(
  authorIds: readonly string[] | undefined,
  behavior?: Pick<RankingUserBehavior, 'hiddenAuthors' | 'mutedAuthors' | 'blockedAuthors'>,
  blockedIds: readonly string[] = [],
): string[] {
  const excluded = new Set([
    ...blockedIds,
    ...(behavior?.hiddenAuthors ?? []),
    ...(behavior?.mutedAuthors ?? []),
    ...(behavior?.blockedAuthors ?? []),
  ]);
  return [...new Set(authorIds ?? [])].filter((id) => !excluded.has(id));
}
