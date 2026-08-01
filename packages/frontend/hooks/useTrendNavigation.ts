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

  const navigateToTrend = useCallback((
    trend: Trend,
    surface: TrendEventSurface,
    rank?: number,
  ) => {
    if (!trend.text?.trim()) return;

    reportTrendEvent({
      event: 'click',
      type: trend.type,
      surface,
      ...(rank !== undefined ? { rank } : {}),
      ...(trend.recId ? { recId: trend.recId } : {}),
    });

    // EVERY trend opens the trend feed, including one whose term people mostly
    // spelled with a `#`. The hashtag screen matches the `#` form only, which is
    // a strict subset of what made the term trend — sending a hashtag-shaped
    // trend there hid exactly the prose posts that the burst was measured from.
    // `/hashtag/<tag>` still exists and is still where a tag INSIDE a post goes;
    // it is simply not what a trend means any more.
    const params = new URLSearchParams();
    // The label is carried so the screen can title itself correctly on the first
    // frame. It is an optimization, not the source of truth: a cold deep link
    // arrives without it and the screen falls back to the term.
    if (trend.displayName && trend.displayName !== trend.text) {
      params.set('label', trend.displayName);
    }
    if (trend.category) params.set('category', trend.category);
    const query = params.toString();
    router.push(`/trend/${encodeURIComponent(trend.text)}${query ? `?${query}` : ''}`);
  }, [router]);

  return { navigateToTrend };
}
