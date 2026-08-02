import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import type { TrendEventSurface } from '@mention/shared-types';
import { WEB_BASE_URL } from '@/config';
import type { Trend } from '@/interfaces/Trend';
import { reportTrendEvent } from '@/utils/feedTelemetry';

/**
 * Build the canonical shareable web URL for a trend — mirrors the in-app route
 * resolved by `navigateToTrend` so the link a user shares lands on the same place.
 */
export function buildTrendUrl(trend: Trend): string {
  return `${WEB_BASE_URL}/trend/${encodeURIComponent(trend.text)}`;
}

/**
 * Open a trend, and count the press.
 *
 * The reporting is deliberately HERE rather than in each caller: every surface
 * that shows a trend routes through this one hook, so a new surface cannot ship
 * navigation without measurement. `surface` and the rendered `rank` are what the
 * caller knows and this hook cannot.
 *
 * The report never blocks the navigation — it is fire-and-forget, and the
 * `router.push` runs on the same tick regardless of whether the write succeeds.
 */
export function useTrendNavigation() {
  const router = useRouter();

  /**
   * Open a term, for a surface that has a term and not a `Trend`.
   *
   * The relation graph is that surface: a node is a measured term, and most
   * nodes never became trends at all — they have no `type`, no score and no
   * label. Assembling a `Trend` around one to reach the navigation would mean
   * inventing every one of those fields, so the primitive takes what the caller
   * genuinely has. `navigateToTrend` is this plus the fields a real row adds.
   */
  const navigateToTerm = useCallback((
    term: string,
    surface: TrendEventSurface,
    extra: { type?: Trend['type']; rank?: number; recId?: string } = {},
  ) => {
    if (!term.trim()) return;

    reportTrendEvent({
      event: 'click',
      // `unclassified` for a graph node — a term the detector measured but never
      // filed as a row. Naming that plainly keeps the metric honest; guessing
      // one of the other three would label it with a value nothing produced.
      type: extra.type ?? 'unclassified',
      surface,
      ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
      ...(extra.recId ? { recId: extra.recId } : {}),
    });

    /*
     * EVERY trend opens the trend feed, including one whose term people mostly
     * spelled with a `#`. The hashtag screen matches the `#` form only, which
     * is a strict subset of what made the term trend, so sending a
     * hashtag-shaped trend there hid exactly the prose posts the burst was
     * measured from. `/hashtag/<tag>` is still where a tag INSIDE a post goes.
     *
     * The TERM is the whole address. Carrying the label alongside it would give
     * one resource two URLs, freeze a shared link's title at the moment it was
     * copied — so it lies once the term is relabelled — and let a crafted URL
     * show a reader a name the server never chose. The screen resolves the
     * presentation from the term.
     */
    router.push(`/trend/${encodeURIComponent(term)}`);
  }, [router]);

  const navigateToTrend = useCallback((
    trend: Trend,
    surface: TrendEventSurface,
    rank?: number,
  ) => {
    navigateToTerm(trend.text, surface, {
      type: trend.type,
      ...(rank !== undefined ? { rank } : {}),
      ...(trend.recId ? { recId: trend.recId } : {}),
    });
  }, [navigateToTerm]);

  return { navigateToTrend, navigateToTerm };
}
