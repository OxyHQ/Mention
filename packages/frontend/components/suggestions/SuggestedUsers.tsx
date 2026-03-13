import React, { memo, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { View, FlatList, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { useUsersStore } from '@/stores/usersStore';
import { SuggestedUserCard } from './SuggestedUserCard';
import type { SuggestedUserData } from './SuggestedUserCard';

interface SuggestedUsersProps {
  visible?: boolean;
  sourceUserId?: string;
  title?: string;
  maxCards?: number;
}

const DEFAULT_MAX_CARDS = 10;

const ItemSeparator = () => <View style={styles.separator} />;

export const SuggestedUsers = memo(function SuggestedUsers({
  visible = true,
  sourceUserId,
  title,
  maxCards = DEFAULT_MAX_CARDS,
}: SuggestedUsersProps) {
  const { oxyServices, isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const theme = useTheme();

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
            console.warn('SuggestedUsers: failed to cache users:', e);
          }
        }
      } catch (err) {
        if (!mounted) return;
        console.error('SuggestedUsers: error fetching recommendations:', err);
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

  const renderItem = useCallback(({ item }: { item: SuggestedUserData }) => (
    <SuggestedUserCard user={item} onDismiss={handleDismiss} />
  ), [handleDismiss]);

  if (!visible || !isAuthenticated || loading || displayedUsers.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <ThemedText style={[styles.title, { color: theme.colors.text }]}>
        {title || t('Suggested for you')}
      </ThemedText>
      <FlatList
        data={displayedUsers}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={ItemSeparator}
      />
    </View>
  );
});

const keyExtractor = (item: SuggestedUserData) => item.id;

const styles = StyleSheet.create({
  container: {
    paddingTop: 12,
    paddingBottom: 4,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  listContent: {
    paddingHorizontal: 12,
  },
  separator: {
    width: 8,
  },
});
