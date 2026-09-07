/**
 * The numbers the capture surface is built from.
 *
 * Here rather than inline because three of them are decisions rather than
 * measurements, and a reader deciding whether to change one should find the
 * reasoning next to the value.
 */

/**
 * Longest single recording, in seconds.
 *
 * Three minutes, deliberately between the two obvious answers. Instagram raised
 * its own ceiling to twenty minutes in 2026, but it still only RECOMMENDS reels
 * under three — and the cost here is not the recording, it is the upload:
 * `oxyServices.assetUpload` sends the whole file in one request, with no
 * chunking and no resume, so a connection that drops loses the lot. Three
 * minutes triples the old ceiling without turning an ordinary capture into a
 * multi-hundred-megabyte upload from mobile data.
 */
export const MAX_VIDEO_SECONDS = 180;

/** Self-timer choices, in seconds. `0` is off, and is what the control starts on. */
export const TIMER_CHOICES = [0, 3, 10] as const;
export type TimerChoice = (typeof TIMER_CHOICES)[number];

/** Flash choices, in the order the control cycles through them. */
export const FLASH_CHOICES = ['off', 'auto', 'on'] as const;
export type FlashChoice = (typeof FLASH_CHOICES)[number];

/**
 * How far the finger must travel UP from the shutter to reach full zoom.
 *
 * A fixed distance rather than a fraction of the screen: the gesture starts at
 * the shutter and the thumb's reach is what limits it, not the display. 220px is
 * about the span of a thumb pivoting from the shutter on a phone held one-handed.
 */
export const ZOOM_DRAG_DISTANCE_PX = 220;

/** How long a press must be held before it starts recording instead of taking a photo. */
export const HOLD_TO_RECORD_MS = 250;

/** Cycle a choice list, wrapping at the end. Shared by the flash and timer controls. */
export function nextChoice<T>(choices: readonly T[], current: T): T {
  const index = choices.indexOf(current);
  // An unknown current value restarts the cycle rather than throwing: a control
  // that stops responding is worse than one that resets.
  return choices[(index + 1) % choices.length] ?? choices[0]!;
}
