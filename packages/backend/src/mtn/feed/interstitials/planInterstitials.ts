/**
 * Feed interstitial PLANNER — decides WHICH recommendation card goes WHERE on
 * this page, and nothing else.
 *
 * The function is pure and synchronous: it reads only what the feed request has
 * already loaded (the page's slices and the viewer's follow count), so planning
 * a page costs the feed response zero extra I/O and can never block it on
 * recommendation data. The client fetches each card's CONTENT lazily from the
 * dedicated, already-cached recommendation endpoints.
 *
 * Every threshold, position and rotation lives in
 * `MtnConfig.feed.interstitials` — this file contains no tuning constants.
 */

import { MtnConfig, isValidFeedDescriptor, parseFeedDescriptor } from '@mention/shared-types';
import type { FeedInterstitialKind, FeedInterstitialSlot, FeedPostSlice } from '@mention/shared-types';

const INTERSTITIALS = MtnConfig.feed.interstitials;

/**
 * The one kind the PROFILE (author) feed carries: accounts similar to the profile
 * being read.
 */
const PROFILE_KIND: FeedInterstitialKind = 'similarAccounts';

/**
 * How dense the viewer's follow graph is. Drives both the positions and the
 * rotation of card kinds: a viewer who follows almost nobody needs bootstrapping
 * (starter packs first, early on the page), while a viewer who already follows
 * hundreds wants the occasional individual account.
 */
type GraphTemperature = keyof typeof INTERSTITIALS.positions;

export interface PlanInterstitialsParams {
  /** The feed descriptor being served (`for_you`, `hashtag|cats`, …). */
  descriptor: string;
  /** The page's slices, ALREADY truncated to the requested limit. */
  slices: FeedPostSlice[];
  /** Size of the viewer's follow graph (`context.followingIds.length`). */
  followingCount: number;
  /** True for the first page of a feed (no cursor). */
  isFirstPage: boolean;
  /** The request's cursor, used as the deterministic rotation/cadence seed. */
  cursor?: string;
  /**
   * The VIEWER's Oxy id. Passed rather than inferred: the profile card must be
   * dropped when the viewer is reading their own profile, and the planner cannot
   * know that from the descriptor alone.
   */
  currentUserId?: string;
}

/**
 * The descriptor's leading token: `for_you` stays `for_you`, `hashtag|cats`
 * becomes `hashtag`. Only the base is matched against the allowlist, so a
 * parameterized variant of an allowed feed is treated like the feed itself.
 */
function baseDescriptor(descriptor: string): string {
  return descriptor.trim().toLowerCase().split('|')[0] ?? '';
}

function isAllowedDescriptor(descriptor: string): boolean {
  const base = baseDescriptor(descriptor);
  return INTERSTITIALS.allowedDescriptors.some((allowed) => allowed === base);
}

/**
 * The SUBJECT of an author feed — the profile whose posts are being read —
 * or `undefined` when the descriptor is not an author feed at all.
 *
 * The descriptor is parsed through the shared parser (`author|<oxyUserId>`,
 * `author|<oxyUserId>|<filter>`) rather than hand-split, so every author variant
 * (posts / replies / media / likes) resolves to the same subject.
 */
function authorSubjectId(descriptor: string): string | undefined {
  if (!isValidFeedDescriptor(descriptor)) return undefined;

  const { source, params } = parseFeedDescriptor(descriptor);
  if (source !== 'author') return undefined;

  const subjectId = params[0]?.trim();
  return subjectId ? subjectId : undefined;
}

/**
 * The profile feed's card placements: one `similarAccounts` card, anchored at the
 * configured slice index for this page.
 *
 * This surface is deliberately OUTSIDE the graph-temperature model below. That
 * model asks how much bootstrapping the VIEWER needs; this card is about the
 * feed's SUBJECT ("who else is like this account"), which is just as useful to a
 * viewer who already follows a thousand people.
 */
function planProfileInterstitials(
  subjectId: string,
  slices: FeedPostSlice[],
  isFirstPage: boolean,
): FeedInterstitialSlot[] {
  const positions: readonly number[] = INTERSTITIALS.profile.positions[isFirstPage ? 'firstPage' : 'nextPage'];

  const slots: FeedInterstitialSlot[] = [];
  for (const index of [...positions].sort((a, b) => a - b)) {
    // A page shorter than the configured position simply yields no card there.
    const afterSliceKey = slices[index]?._sliceKey;
    if (!afterSliceKey) continue;

    slots.push({
      key: `int:${PROFILE_KIND}:${afterSliceKey}`,
      kind: PROFILE_KIND,
      afterSliceKey,
      subjectId,
    });
  }

  return slots;
}

function classifyGraph(followingCount: number): GraphTemperature {
  if (followingCount < INTERSTITIALS.coldMaxFollowing) return 'cold';
  if (followingCount > INTERSTITIALS.denseMinFollowing) return 'dense';
  return 'warm';
}

/**
 * FNV-1a (32-bit). The planner must be DETERMINISTIC — the same request has to
 * plan the same slots every time, so a retry or a re-render can never reshuffle
 * the feed. The cursor is the only per-page entropy available, and it is opaque,
 * so it is hashed into a stable page ordinal instead of parsed.
 */
function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Deterministic ordinal for the page being served. The first page is 0; every
 * later page derives its ordinal from its (opaque) cursor. It is a stable label,
 * not a count — it only has to be identical across retries of the same request
 * and to vary between different pages.
 */
function pageOrdinal(isFirstPage: boolean, cursor: string | undefined): number {
  if (isFirstPage || !cursor) return 0;
  return stableHash(cursor);
}

/**
 * Where the card rotation STARTS on this page. The first page starts at the head
 * of the rotation; a later page starts at a non-zero, cursor-derived offset so it
 * never re-opens with the kind the first page already showed.
 */
function rotationOffset(rotationLength: number, page: number): number {
  if (page === 0 || rotationLength <= 1) return 0;
  return 1 + (page % (rotationLength - 1));
}

/**
 * A dense graph gets a card only every `densePageInterval`-th page. The gate is
 * evaluated on the deterministic page ordinal, never on a random draw.
 */
function passesCadenceGate(temperature: GraphTemperature, page: number): boolean {
  if (temperature !== 'dense') return true;
  return page % INTERSTITIALS.densePageInterval === 0;
}

/**
 * Plan this page's recommendation-card placements.
 *
 * Two independent surfaces carry cards:
 *   - the AUTHOR (profile) feed gets one `similarAccounts` card about the profile
 *     being read — dropped on the viewer's own profile, where there is nobody
 *     "similar to you" worth suggesting to you;
 *   - the home surfaces (`allowedDescriptors`) get the graph-temperature mix.
 *
 * Returns `[]` — no cards — whenever the feed isn't a card-carrying surface, the
 * cadence gate closes, or the page is too short to reach any configured position.
 * The caller only invokes this for AUTHENTICATED viewers: an anonymous page is
 * cached verbatim and must never carry anything personalized.
 */
export function planInterstitials(params: PlanInterstitialsParams): FeedInterstitialSlot[] {
  const { descriptor, slices, followingCount, isFirstPage, cursor, currentUserId } = params;

  if (slices.length === 0) return [];

  const subjectId = authorSubjectId(descriptor);
  if (subjectId) {
    if (subjectId === currentUserId) return [];
    return planProfileInterstitials(subjectId, slices, isFirstPage);
  }

  if (!isAllowedDescriptor(descriptor)) return [];

  const temperature = classifyGraph(followingCount);
  const page = pageOrdinal(isFirstPage, cursor);
  if (!passesCadenceGate(temperature, page)) return [];

  const positions: readonly number[] = INTERSTITIALS.positions[temperature][isFirstPage ? 'firstPage' : 'nextPage'];
  const rotation: readonly FeedInterstitialKind[] = INTERSTITIALS.rotation[temperature];
  const offset = rotationOffset(rotation.length, page);

  const slots: FeedInterstitialSlot[] = [];
  // Positions are read in ascending order so the rotation advances down the page.
  for (const index of [...positions].sort((a, b) => a - b)) {
    // A page shorter than the configured position simply yields no card there.
    const anchor = slices[index];
    const afterSliceKey = anchor?._sliceKey;
    if (!afterSliceKey) continue;

    const kind = rotation[(offset + slots.length) % rotation.length];
    slots.push({ key: `int:${kind}:${afterSliceKey}`, kind, afterSliceKey });
  }

  return slots;
}
