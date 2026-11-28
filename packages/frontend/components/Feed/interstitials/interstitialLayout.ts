import type { FeedInterstitialKind } from '@mention/shared-types';

/**
 * Geometry, sizing and fetch bounds for the feed's recommendation bands, in ONE
 * place.
 *
 * Every interstitial is the same horizontal carousel of cards on every screen
 * size (Bloom's `Carousel`: swiped on touch, arrows beside the title on a wide
 * screen), so the numbers that define it (card widths, how many items a band
 * shows, how few make it not worth showing at all) belong to the family, not
 * to any one card.
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
 * Width of one card, by what the card holds.
 *
 * - `profile`: the vertical person tile (avatar over name, bio and Follow), the
 *   width X and Instagram use. About two and a quarter fit a phone, so the next
 *   one always peeks in and invites the swipe.
 * - `wide`: a starter pack or a feed, which read as a card with a facepile and a
 *   paragraph, not a tile.
 * - `trend`: one trend row (kicker, name, count).
 */
export const INTERSTITIAL_CARD_WIDTH = {
  profile: 172,
  wide: 280,
  trend: 220,
} as const;

/** Horizontal space between two carousel cards. */
export const INTERSTITIAL_CARD_GAP = 12;

/** Inset from the band's edges to its title and to the first/last card. */
export const INTERSTITIAL_EDGE_PADDING = 12;

/** The trailing "See more" card is narrower than a content card. */
export const INTERSTITIAL_SEE_MORE_CARD_WIDTH = 148;

/**
 * Fewer suggestions than this and the band costs more (a header, a border, a
 * scroll interruption) than it gives back — the interstitial renders nothing.
 * A carousel that cannot be swiped reads as broken, so the floor is four.
 */
const MIN_ITEMS = 4;

/**
 * How many suggestions one band shows. A carousel only costs a swipe, not the
 * posts it would push down the page, so the band can run deep.
 */
const MAX_ITEMS: Record<FeedInterstitialKind, number> = {
  suggestedUsers: 8,
  suggestedFeeds: 6,
  suggestedStarterPacks: 6,
  // Similar accounts are the same person tile as "who to follow", from a pool
  // the subject's own graph bounds — so it shares that band's shape.
  similarAccounts: 8,
  // Trends are read, not acted on one by one, so the band stays short — a
  // glanceable few rather than a second feed. The pool itself is only ten deep
  // (what the trends store fetches), which also bounds how many bands can offset
  // into it before one comes up empty and renders nothing.
  trendingTopics: 5,
};

/**
 * Placeholders shown while the suggestions load — as many as will be seen. A
 * wide feed column shows more of the row than a phone does.
 */
export const INTERSTITIAL_SKELETON_ITEMS = {
  desktop: 4,
  mobile: 2,
} as const;

export interface InterstitialLimits {
  /** Below this many available items, the band does not render. */
  minItems: number;
  /** At most this many items are shown at once. */
  maxItems: number;
}

/** One frozen limits object per kind, so a band's memo over `limits` holds. */
const LIMITS = Object.fromEntries(
  Object.entries(MAX_ITEMS).map(([kind, maxItems]) => [kind, { minItems: MIN_ITEMS, maxItems }]),
) as Record<FeedInterstitialKind, InterstitialLimits>;

/** Resolve a kind's item limits — the same on every screen, since every band is a carousel. */
export function resolveInterstitialLimits(kind: FeedInterstitialKind): InterstitialLimits {
  return LIMITS[kind];
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
