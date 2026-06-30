import React, { memo, useState, useMemo, useCallback } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { ThemedText } from '@/components/ThemedText';
import { queryClient } from '@/lib/queryClient';
import { precacheProfileViews } from '@/lib/precacheProfiles';
import { enrichMissingAvatars } from '@/utils/userEnrichment';
import { SuggestedUserCard } from './SuggestedUserCard';
import type { SuggestedUserData } from './SuggestedUserCard';
import { logger } from '@/lib/logger';
import { type ProfileData } from '@/lib/recommendations';
import { useRecommendations } from '@/hooks/useRecommendations';

interface SuggestedUsersProps {
  visible?: boolean;
  sourceUserId?: string;
  title?: string;
  maxCards?: number;
  hideDismiss?: boolean;
}

const DEFAULT_MAX_CARDS = 10;

/** Similar-profiles stay fresh for 5 minutes (mirrors the recommendations cache). */
const SIMILAR_PROFILES_STALE_TIME_MS = 5 * 60_000;

export const SuggestedUsers = memo(function SuggestedUsers({
  visible = true,
  sourceUserId,
  title,
  maxCards = DEFAULT_MAX_CARDS,
  hideDismiss,
}: SuggestedUsersProps) {
  const { oxyServices, user } = useAuth();
  const { t } = useTranslation();

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const hasSource = Boolean(sourceUserId);

  // Similarity path: when a `sourceUserId` is given, suggest profiles similar to
  // it. Keyed on the source + viewer so it stays deduped/cached and reloads when
  // the session lands. Falls back to shared recommendations on error (below).
  const similarQuery = useQuery<ProfileData[]>({
    queryKey: ['similarProfiles', sourceUserId ?? '', user?.id ?? 'anon'],
    queryFn: async () => {
      const src = sourceUserId;
      if (!src) return [];
      // `getSimilarProfiles` returns the SDK `User` shape (optional id); narrow
      // through `unknown` to the looser `ProfileData`, the same erasure the
      // recommendations path produces.
      const similar: unknown = await oxyServices.getSimilarProfiles(src);
      const list: ProfileData[] = Array.isArray(similar) ? similar : [];
      if (list.length > 0) {
        precacheProfileViews(queryClient, list);
        void enrichMissingAvatars(
          list.slice(0, maxCards),
          (ids) => oxyServices.getUsersByIds(ids),
          queryClient,
        );
      }
      return list;
    },
    enabled: visible && hasSource,
    staleTime: SIMILAR_PROFILES_STALE_TIME_MS,
  });

  if (similarQuery.isError) {
    logger.warn('SuggestedUsers: getSimilarProfiles failed, falling back to recommendations', {
      error: similarQuery.error,
    });
  }

  // Shared recommendations: the default source (no `sourceUserId`) AND the
  // fallback when the similarity lookup errors. Disabled otherwise so a
  // successful similarity result doesn't trigger an extra recommendations fetch.
  const { recommendations } = useRecommendations({
    enabled: visible && (!hasSource || similarQuery.isError),
  });

  const sourceUsers = useMemo<ProfileData[]>(
    () => (hasSource && !similarQuery.isError ? similarQuery.data ?? [] : recommendations),
    [hasSource, similarQuery.isError, similarQuery.data, recommendations],
  );

  const handleDismiss = useCallback((userId: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(userId);
      return next;
    });
  }, []);

  const displayedUsers = useMemo(() => {
    const result: SuggestedUserData[] = [];
    for (const candidate of sourceUsers) {
      if (result.length >= maxCards) break;
      if (dismissedIds.has(candidate.id)) continue;
      if (sourceUserId && candidate.id === sourceUserId) continue;
      result.push(candidate);
    }
    return result;
  }, [sourceUsers, dismissedIds, sourceUserId, maxCards]);

  if (!visible || displayedUsers.length === 0) {
    return null;
  }

  return (
    <View className="pt-3">
      <ThemedText className="text-foreground text-[15px] font-bold px-4 mb-1">
        {title || t('Suggested for you')}
      </ThemedText>
      {displayedUsers.map((suggested) => (
        <SuggestedUserCard key={suggested.id} user={suggested} onDismiss={handleDismiss} hideDismiss={hideDismiss} />
      ))}
    </View>
  );
});
