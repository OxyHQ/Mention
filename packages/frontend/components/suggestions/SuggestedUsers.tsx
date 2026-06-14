import React, { memo, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { ThemedText } from '@/components/ThemedText';
import { queryClient } from '@/lib/queryClient';
import { precacheProfileViews } from '@/lib/precacheProfiles';
import { enrichMissingAvatars } from '@/utils/userEnrichment';
import { SuggestedUserCard } from './SuggestedUserCard';
import type { SuggestedUserData } from './SuggestedUserCard';
import { logger } from '@/lib/logger';
import { isAuthError } from '@/utils/authErrors';

interface SuggestedUsersProps {
  visible?: boolean;
  sourceUserId?: string;
  title?: string;
  maxCards?: number;
  hideDismiss?: boolean;
}

/**
 * A recommended/similar profile as returned by the SDK. Derived from
 * `getProfileRecommendations` so it stays in lockstep with the source of truth;
 * it carries the SDK's index signature, which makes it assignable both to the
 * cache helpers (`precacheProfileViews` / `enrichMissingAvatars`) and to the
 * `SuggestedUserData` card shape.
 */
type RecommendedUser = Awaited<
  ReturnType<ReturnType<typeof useAuth>['oxyServices']['getProfileRecommendations']>
>[number];

const DEFAULT_MAX_CARDS = 10;

export const SuggestedUsers = memo(function SuggestedUsers({
  visible = true,
  sourceUserId,
  title,
  maxCards = DEFAULT_MAX_CARDS,
  hideDismiss,
}: SuggestedUsersProps) {
  const { oxyServices } = useAuth();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [recommendations, setRecommendations] = useState<SuggestedUserData[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const fetchInFlightRef = useRef(false);

  useEffect(() => {
    if (!visible) return;

    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;

    let mounted = true;

    const fetchRecommendations = async () => {
      try {
        setLoading(true);
        let response: unknown;
        if (sourceUserId) {
          try {
            response = await oxyServices.getSimilarProfiles(sourceUserId);
          } catch (error) {
            logger.warn('SuggestedUsers: getSimilarProfiles failed, falling back to recommendations', { error });
            response = await oxyServices.getProfileRecommendations();
          }
        } else {
          response = await oxyServices.getProfileRecommendations();
        }
        if (!mounted) return;

        const users: RecommendedUser[] = Array.isArray(response) ? response : [];
        setRecommendations(users);

        if (users.length > 0) {
          precacheProfileViews(queryClient, users);

          // Fire-and-forget: avatars fill in reactively via useUserById
          void enrichMissingAvatars(
            users.slice(0, maxCards),
            (id) => oxyServices.getUserById(id),
            queryClient,
          );
        }
      } catch (err) {
        if (!mounted) return;
        // Recommendations are public; on the rare auth error degrade quietly to
        // the empty state (component renders nothing) instead of logging it loud.
        if (isAuthError(err)) {
          logger.warn('SuggestedUsers: auth error fetching recommendations, showing empty state', { error: err });
        } else {
          logger.error('SuggestedUsers: error fetching recommendations', { error: err });
        }
      } finally {
        fetchInFlightRef.current = false;
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchRecommendations();

    return () => {
      mounted = false;
    };
  }, [oxyServices, visible, sourceUserId]);

  const handleDismiss = useCallback((userId: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(userId);
      return next;
    });
  }, []);

  const displayedUsers = useMemo(() => {
    const result: SuggestedUserData[] = [];
    for (const user of recommendations) {
      if (result.length >= maxCards) break;
      if (dismissedIds.has(user.id)) continue;
      if (sourceUserId && user.id === sourceUserId) continue;
      result.push(user);
    }
    return result;
  }, [recommendations, dismissedIds, sourceUserId, maxCards]);

  if (!visible || loading || displayedUsers.length === 0) {
    return null;
  }

  return (
    <View className="pt-3">
      <ThemedText className="text-foreground text-[15px] font-bold px-4 mb-1">
        {title || t('Suggested for you')}
      </ThemedText>
      {displayedUsers.map((user) => (
        <SuggestedUserCard key={user.id} user={user} onDismiss={handleDismiss} hideDismiss={hideDismiss} />
      ))}
    </View>
  );
});
