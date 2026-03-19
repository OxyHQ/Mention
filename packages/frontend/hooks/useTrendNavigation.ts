import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import type { Trend } from '@/interfaces/Trend';

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
