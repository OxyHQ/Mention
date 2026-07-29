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
  if (trend.type === 'hashtag') {
    const tag = (trend.hashtag || trend.text).replace(/^#/, '');
    return `${WEB_BASE_URL}/hashtag/${encodeURIComponent(tag)}`;
  }
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

    if (trend.type === 'hashtag') {
      const tag = (trend.hashtag || trend.text).replace(/^#/, '');
      router.push(`/hashtag/${encodeURIComponent(tag)}`);
    } else {
      const params = new URLSearchParams();
      if (trend.description) params.set('description', trend.description);
      params.set('type', trend.type);
      const query = params.toString();
      router.push(`/trend/${encodeURIComponent(trend.text)}${query ? `?${query}` : ''}`);
    }
  }, [router]);

  return { navigateToTrend };
}
