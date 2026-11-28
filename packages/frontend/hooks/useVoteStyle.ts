// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useThreadPreferencesStore } from '@/hooks/useThreadPreferences';
import type { VoteStyle } from '@/hooks/useThreadPreferences';

export type { VoteStyle };

/**
 * The viewer's like-control style, from the one shared thread-preferences store.
 *
 * It reads the store rather than loading storage per caller: a per-caller copy
 * meant every mounted post kept whichever value it had loaded, so changing the
 * style in settings left already-rendered posts on the old one until they
 * remounted.
 */
export function useVoteStyle(): VoteStyle {
  return useThreadPreferencesStore((state) => state.voteStyle);
}
