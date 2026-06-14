import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { WEB_BASE_URL } from '@/config';
import type { Trend } from '@/interfaces/Trend';

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

export function useTrendNavigation() {
  const router = useRouter();

  const navigateToTrend = useCallback((trend: Trend) => {
    if (!trend.text?.trim()) return;

    if (trend.type === 'hashtag') {
      const tag = (trend.hashtag || trend.text).replace(/^#/, '');
      router.push(`/hashtag/${encodeURIComponent(tag)}` as any);
    } else {
      router.push({
        pathname: `/trend/${encodeURIComponent(trend.text)}` as any,
        params: { description: trend.description, type: trend.type },
      });
    }
  }, [router]);

  return { navigateToTrend };
}
