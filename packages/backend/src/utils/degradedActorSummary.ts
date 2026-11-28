// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { PostUser } from '@mention/shared-types';

export type DegradedActorSummary = PostUser & {
  username: string;
  name: { displayName: string };
  avatar: null;
};

/**
 * Canonical unresolved-user placeholder.
 *
 * The raw Oxy id remains available only as the DTO identifier. Visual identity
 * fields deliberately contain no id-derived handle, so clients cannot render a
 * transient lookup failure as a real account.
 */
export function degradedActorSummary(userId: string): DegradedActorSummary {
  return {
    id: userId,
    username: '',
    name: { displayName: 'Unknown user' },
    avatar: null,
  };
}
