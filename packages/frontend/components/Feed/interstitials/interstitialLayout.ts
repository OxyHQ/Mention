import type { FeedInterstitialKind } from '@mention/shared-types';

/**
 * Geometry, sizing and fetch bounds for the feed's recommendation bands, in ONE
 * place.
 *
 * Every interstitial renders the same two layouts — a snapping horizontal
 * carousel on phones, a vertical list of full-width rows on wider screens — so
 * the numbers that define them (card width, snap step, how many items a band
 * shows, how few make it not worth showing at all) belong to the family, not to
 * any one card.
 */

/**
 * How long a band's suggestions stay fresh. Matches the recommendations hooks so
 * every discovery surface in the app ages out together.
 */
export const INTERSTITIAL_STALE_TIME_MS = 5 * 60_000;

/**
 * How many feeds one marketplace read pulls. Deep enough that consecutive bands
 * (which offset into the same cached page by `ordinal`) each get fresh items,
 * shallow enough to stay a single cheap request.
 */
export const SUGGESTED_FEEDS_FETCH_LIMIT = 30;

/**
 * Width of one card in the mobile carousel. Wide enough for a profile row
 * (avatar, name, follow button, dismiss) without truncating the name to nothing,
 * narrow enough that the next card still peeks in and invites the swipe.
 */
export const INTERSTITIAL_CARD_WIDTH = 296;

/** Horizontal space between two carousel cards. */
export const INTERSTITIAL_CARD_GAP = 12;

/**
 * The carousel snaps by a WHOLE card — width plus the gap that follows it.
 * Snapping by the width alone drifts a gap per card and lands mid-card.
 */
export const INTERSTITIAL_SNAP_INTERVAL = INTERSTITIAL_CARD_WIDTH + INTERSTITIAL_CARD_GAP;

/** Inset from the band's edges to the first/last carousel card. */
export const INTERSTITIAL_EDGE_PADDING = 12;

/** The trailing "See more" card is narrower than a content card. */
export const INTERSTITIAL_SEE_MORE_CARD_WIDTH = 148;

export type InterstitialBreakpoint = 'desktop' | 'mobile';

/**
 * Fewer suggestions than this and the band costs more (a header, a border, a
 * scroll interruption) than it gives back — the interstitial renders nothing.
 * The carousel needs a couple more than the list because a card that cannot be
 * swiped reads as broken.
 */
const MIN_ITEMS: Record<InterstitialBreakpoint, number> = {
  desktop: 3,
  mobile: 4,
};

/**
 * How many suggestions one band shows. The vertical list is capped tighter: it
 * pushes real posts down the page, while the carousel only costs a swipe.
 */
const MAX_ITEMS: Record<FeedInterstitialKind, Record<InterstitialBreakpoint, number>> = {
  suggestedUsers: { desktop: 5, mobile: 8 },
  suggestedFeeds: { desktop: 3, mobile: 6 },
  suggestedStarterPacks: { desktop: 3, mobile: 6 },
};

/** Placeholders shown while the suggestions load — as many as will be seen. */
const SKELETON_ITEMS: Record<InterstitialBreakpoint, number> = {
  desktop: 3,
  mobile: 2,
};

export interface InterstitialLimits {
  /** Below this many available items, the band does not render. */
  minItems: number;
  /** At most this many items are shown at once. */
  maxItems: number;
  /** Placeholder count for the loading state. */
  skeletonItems: number;
}

/** Resolve a kind's item limits for the current breakpoint. */
export function resolveInterstitialLimits(
  kind: FeedInterstitialKind,
  isDesktop: boolean,
): InterstitialLimits {
  const breakpoint: InterstitialBreakpoint = isDesktop ? 'desktop' : 'mobile';
  return {
    minItems: MIN_ITEMS[breakpoint],
    maxItems: MAX_ITEMS[kind][breakpoint],
    skeletonItems: SKELETON_ITEMS[breakpoint],
  };
}

/**
 * Whether a band has enough to say to be worth interrupting the feed.
 *
 * An all-but-empty band is a worse interruption than no band: it costs a border,
 * a header and a break in the scroll to show one or two suggestions. Below the
 * minimum the interstitial renders NOTHING — the feed reads as if the server had
 * never planned the slot. While the suggestions are still in flight the band
 * stands (on placeholders), because the overwhelmingly common case is that they
 * arrive.
 *
 * The single gate behind all three kinds' `return null`.
 */
export function shouldRenderInterstitial(
  itemCount: number,
  isLoading: boolean,
  limits: InterstitialLimits,
): boolean {
  if (isLoading) return true;
  return itemCount >= limits.minItems;
}

/**
 * The window of suggestions a band shows: the pool from this band's offset
 * onward, minus what the viewer dismissed, capped to `maxItems`.
 *
 * The offset is what keeps consecutive bands from repeating themselves — the
 * second "who to follow" card in a scroll session starts where the first one
 * ended. Dismissals backfill from further down the pool rather than shrinking
 * the band, so hiding one suggestion never collapses the whole card.
 */
export function selectInterstitialWindow<TItem>(
  pool: readonly TItem[],
  ordinal: number,
  limits: InterstitialLimits,
  keyOf: (item: TItem) => string,
  dismissed: ReadonlySet<string>,
): TItem[] {
  const offset = ordinal * limits.maxItems;
  const available: TItem[] = [];
  for (let i = offset; i < pool.length && available.length < limits.maxItems; i += 1) {
    const item = pool[i];
    if (!dismissed.has(keyOf(item))) available.push(item);
  }
  return available;
}
