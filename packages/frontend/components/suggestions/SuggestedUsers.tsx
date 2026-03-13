import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, FlatList, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { Loading } from '@/components/ui/Loading';
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

export function SuggestedUsers({
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

  useEffect(() => {
    if (!isAuthenticated || !visible) {
      setLoading(false);
      return;
    }

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
        if (mounted) setLoading(false);
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
    return recommendations
      .filter((user) => {
        if (dismissedIds.has(user.id)) return false;
        if (sourceUserId && user.id === sourceUserId) return false;
        return true;
      })
      .slice(0, maxCards);
  }, [recommendations, dismissedIds, sourceUserId, maxCards]);

  if (!visible || !isAuthenticated || loading || displayedUsers.length === 0) {
    return null;
  }

  const renderItem = ({ item }: { item: SuggestedUserData }) => (
    <SuggestedUserCard user={item} onDismiss={handleDismiss} />
  );

  return (
    <View style={styles.container}>
      <ThemedText style={[styles.title, { color: theme.colors.text }]}>
        {title || t('Suggested for you')}
      </ThemedText>
      <FlatList
        data={displayedUsers}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  listContent: {
    paddingHorizontal: 16,
  },
  separator: {
    width: 12,
  },
});
