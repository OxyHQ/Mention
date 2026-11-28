/**
 * Layout constants for the COMPOSE screen and its subcomponents.
 *
 * These are intentionally distinct from the feed list tokens
 * (`POST_ITEM_SPACING` in `styles/shared.ts`): the composer uses 16px horizontal
 * padding (vs the feed's 12px). The avatar size (40px) happens to match the feed,
 * but the two contexts are independent and may diverge — do not merge them.
 * The THREAD_LINE_* tokens below are context-independent and shared with PostItem.
 */
export const HPAD = 16;
export const AVATAR_SIZE = 40;
export const AVATAR_GAP = 12;
export const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP; // 52
export const BOTTOM_LEFT_PAD = HPAD + AVATAR_OFFSET; // 68
export const TIMELINE_LINE_OFFSET = HPAD + AVATAR_SIZE / 2 - 1; // Center timeline on avatar
export const THREAD_LINE_WIDTH = 2;
export const THREAD_LINE_BORDER_RADIUS = 9999;
export const THREAD_LINE_Z_INDEX = -1;
