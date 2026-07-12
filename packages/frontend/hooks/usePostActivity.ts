import { useQuery } from '@tanstack/react-query';
import type { ActivityHeatmapDay } from '@oxyhq/bloom/activity-heatmap';
import { api } from '@/utils/api';

const ACTIVITY_STALE_TIME = 5 * 60 * 1000; // 5 minutes
const ACTIVITY_DAYS = 365;

/**
 * Authored-post activity for a user's contribution heatmap.
 *
 * `GET /statistics/user/:userId/activity?days=365` returns a sparse
 * `{ date: YYYY-MM-DD, count }[]` (only days with count>0); the heatmap grid
 * fills the gaps. The endpoint is public but visibility-aware server-side — a
 * private profile the viewer can't see returns an empty list. We hit it through
 * the authenticated linked client so the viewer's own/followed profiles resolve
 * correctly.
 *
 * `userId` is the Oxy user id (`profile.id`). Returns an empty array while
 * loading, when disabled, or on error — it never surfaces a throw to callers.
 */
export function usePostActivity(userId?: string): ActivityHeatmapDay[] {
  const query = useQuery<ActivityHeatmapDay[]>({
    queryKey: ['postActivity', userId],
    queryFn: async () => {
      const response = await api.get<{ activity: ActivityHeatmapDay[] }>(
        `/statistics/user/${userId}/activity`,
        { days: ACTIVITY_DAYS },
      );
      return response.data.activity ?? [];
    },
    enabled: !!userId,
    staleTime: ACTIVITY_STALE_TIME,
  });

  return query.data ?? [];
}
