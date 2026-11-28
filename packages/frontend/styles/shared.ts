// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Post item layout tokens, shared by the feed row, post detail, notification
 * rows and their skeletons so every post-shaped surface lines up.
 */
const HPAD = 12;
const AVATAR_SIZE = 40;
const AVATAR_GAP = 12;

export const POST_ITEM_SPACING = {
  HPAD,
  VPAD: 12,
  SECTION_GAP: 12,
  AVATAR_SIZE,
  AVATAR_GAP,
  /** Horizontal padding + avatar + gap: where the body column starts (64). */
  AVATAR_OFFSET: HPAD + AVATAR_SIZE + AVATAR_GAP,
} as const;

/** The rendered PostHeader avatar and indentation of a reply branch. */
export const POST_AVATAR_SIZE = 36;
export const REPLY_BRANCH_INDENT = 32;
