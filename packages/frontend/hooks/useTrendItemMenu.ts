import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import type { Trend } from '@/interfaces/Trend';
import { useTrendsStore } from '@/stores/trendsStore';
import { buildTrendUrl } from '@/hooks/useTrendNavigation';
import type { WidgetItemMenuActions } from '@/components/widgets/WidgetItemMenu';
import { shareLink } from '@/utils/shareLink';

/**
 * The ⋯ menu on a trend row — hide it, or share its link.
 *
 * Shared by the right-rail widget and the full Explore › Trending screen so the
 * two cannot diverge. They used to: only the widget offered the menu, so a trend
 * could be hidden from the rail but not from the screen that exists to browse
 * trends, and a hidden trend then kept showing up in the one place a reader went
 * looking for it.
 */
export function useTrendItemMenu(): (trend: Trend) => WidgetItemMenuActions {
  const { t } = useTranslation();
  const hideTrend = useTrendsStore((state) => state.hideTrend);

  return useCallback(
    (trend: Trend) => {
      const trendName =
        trend.type === 'hashtag'
          ? `#${(trend.hashtag || trend.text).replace(/^#/, '')}`
          : trend.text;

      return {
        onNotInterested: () => {
          hideTrend(trend.id);
          toast(t('widgetMenu.trendHidden'), { type: 'success' });
        },
        onShare: () => {
          void shareLink({
            title: trendName,
            url: buildTrendUrl(trend),
            copiedToast: t('widgetMenu.linkCopied'),
            errorToast: t('widgetMenu.shareFailed'),
          });
        },
      };
    },
    [hideTrend, t],
  );
}
