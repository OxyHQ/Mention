// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { AvatarIdentitySummary, PostUser } from '@mention/shared-types';

/** Preserve public identity for avatar groups without serializing unrelated profile fields. */
export function avatarIdentitySummary(user: PostUser): AvatarIdentitySummary {
  const { id, username, name, avatar, kind, character, color, isFederated, instance, federation } =
    user;
  return { id, username, name, avatar, kind, character, color, isFederated, instance, federation };
}
