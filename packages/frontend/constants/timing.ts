/**
 * Centralized timing constants for the frontend.
 * Consolidates hardcoded timeout/debounce values across components.
 */
export const TIMING = {
  /** Debounce delay for search inputs */
  DEBOUNCE_SEARCH: 300,
  /** Debounce delay for mention picker lookups */
  DEBOUNCE_MENTION: 300,
  /** Delay before switching from low-res to high-res image */
  IMAGE_LOW_RES_DISPLAY: 300,
  /** Intersection observer threshold distance for lazy loading */
  IMAGE_INTERSECTION_THRESHOLD: 200,
  /** Fade-in animation duration */
  ANIMATION_FADE_IN: 100,
  /** Cooldown after user actions (like, repost) to prevent duplicates */
  ACTION_COOLDOWN: 300,
  /** Feed refresh debounce */
  FEED_REFRESH_DEBOUNCE: 500,
  /** Toast notification display time */
  TOAST_DURATION: 3000,
  /** Scroll event throttle interval */
  SCROLL_THROTTLE: 16,
} as const;
