// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Declare this vocabulary in Oxy Console for this deployment's registered application. */
export const APPLICATION_PERMISSIONS = [
  {
    key: 'memberships.moderate',
    description: 'Inspect and moderate reported membership content with a durable access audit.',
  },
] as const;
export const MEMBERSHIP_MODERATION_PERMISSION = APPLICATION_PERMISSIONS[0].key;
