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
