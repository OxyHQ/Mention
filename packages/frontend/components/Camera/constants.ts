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

/**
 * What `CameraView`'s `zoom` of 1 means, as a multiplier.
 *
 * `zoom` is a 0–1 abstraction over whatever lens the device has, so this is a
 * LABEL rather than a measurement — the pills and the badge have to say
 * something, and "5×" at the far end is the convention every phone camera uses.
 * It is not a promise about optics.
 */
export const MAX_ZOOM_MULTIPLIER = 5;

/** The multipliers the zoom pills offer. One tap each, as on a phone camera. */
export const ZOOM_STOPS = [1, 2, 3] as const;

/** `zoom` (0–1) as the multiplier a reader is shown. */
export function zoomToMultiplier(zoom: number): number {
  return 1 + zoom * (MAX_ZOOM_MULTIPLIER - 1);
}

/** The inverse, for a pill that sets the zoom it is labelled with. */
export function multiplierToZoom(multiplier: number): number {
  const zoom = (multiplier - 1) / (MAX_ZOOM_MULTIPLIER - 1);
  return Math.min(1, Math.max(0, zoom));
}

/**
 * How a multiplier is written.
 *
 * Whole numbers stay whole — "2×", not "2.0×" — because a pill sitting exactly
 * on its own stop should read like the label it is, and a decimal there makes
 * the row look like it is measuring something it is not.
 */
export function formatMultiplier(multiplier: number): string {
  const rounded = Math.round(multiplier * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}×`;
}

/** Which stop a zoom counts as being on, or `null` between two of them. */
export function stopForZoom(zoom: number): number | null {
  const multiplier = zoomToMultiplier(zoom);
  return ZOOM_STOPS.find((stop) => Math.abs(stop - multiplier) < 0.05) ?? null;
}

/** What the capture button is currently for. */
export type CaptureMode = 'photo' | 'video';

/**
 * What a TAP on the shutter does.
 *
 * Pulled out of the component because it is the one rule a reader of this screen
 * has to hold in their head, and it is three lines that are easy to get subtly
 * wrong: in video mode a tap starts and a second tap stops, so a recording must
 * be checked BEFORE the mode. Holding is not here — a hold always records, in
 * either mode, and that is the Pressable's `onLongPress`.
 */
export function shutterAction(
  captureMode: CaptureMode,
  isRecording: boolean,
): 'stop' | 'record' | 'photo' {
  if (isRecording) return 'stop';
  return captureMode === 'video' ? 'record' : 'photo';
}

/** How long a press must be held before it starts recording instead of taking a photo. */
export const HOLD_TO_RECORD_MS = 250;

/** Cycle a choice list, wrapping at the end. Shared by the flash and timer controls. */
export function nextChoice<T>(choices: readonly T[], current: T): T {
  const index = choices.indexOf(current);
  // An unknown current value restarts the cycle rather than throwing: a control
  // that stops responding is worse than one that resets.
  return choices[(index + 1) % choices.length] ?? choices[0]!;
}
