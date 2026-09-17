import { RiArrowDownLine, RiLineChartLine, RiTimeLine } from '@oxy.so/bloom/icons';
import type { SortOrder } from '@/hooks/useThreadPreferences';
import type { BloomIcon } from '@/components/settings/RowIcon';

/** The glyph each reply sort order is shown with, wherever the choice is offered. */
export const SORT_ICONS: Record<SortOrder, BloomIcon> = {
  top: RiLineChartLine,
  oldest: RiTimeLine,
  newest: RiArrowDownLine,
};
