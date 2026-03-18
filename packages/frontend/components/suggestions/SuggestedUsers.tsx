import React, { memo, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { ThemedText } from '@/components/ThemedText';
import { useUsersStore } from '@/stores/usersStore';
import { SuggestedUserCard } from './SuggestedUserCard';
import type { SuggestedUserData } from './SuggestedUserCard';
import { logger } from '@/lib/logger';

interface SuggestedUsersProps {
  visible?: boolean;
  sourceUserId?: string;
  title?: string;
  maxCards?: number;
}

const DEFAULT_MAX_CARDS = 10;

export const SuggestedUsers = memo(function SuggestedUsers({
  visible = true,
  sourceUserId,
  title,
  maxCards = DEFAULT_MAX_CARDS,
}: SuggestedUsersProps) {
  const { oxyServices, isAuthenticated } = useAuth();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [recommendations, setRecommendations] = useState<SuggestedUserData[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const fetchInFlightRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !visible) return;
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;

    let mounted = true;

    const fetchRecommendations = async () => {
      try {
        setLoading(true);
        const response = await oxyServices.getProfileRecommendations();
        if (!mounted) return;

        const users = Array.isArray(response) ? response : [];
        setRecommendations(users);

        if (users.length > 0) {
          try {
            useUsersStore.getState().upsertMany(users);
          } catch (e) {
            logger.warn('SuggestedUsers: failed to cache users');
          }
        }
      } catch (err) {
        if (!mounted) return;
        logger.error('SuggestedUsers: error fetching recommendations');
      } finally {
        if (mounted) {
          setLoading(false);
          fetchInFlightRef.current = false;
        }
      }
    };

    fetchRecommendations();

    return () => {
      mounted = false;
    };
  }, [oxyServices, isAuthenticated, visible]);

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

  if (!visible || !isAuthenticated || loading || displayedUsers.length === 0) {
    return null;
  }

  return (
    <View className="pt-3">
      <ThemedText className="text-foreground text-[15px] font-bold px-4 mb-1">
        {title || t('Suggested for you')}
      </ThemedText>
      {displayedUsers.map((user) => (
        <SuggestedUserCard key={user.id} user={user} onDismiss={handleDismiss} />
      ))}
    </View>
  );
});
