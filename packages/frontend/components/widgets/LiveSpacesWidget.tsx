import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';

import { BaseWidget } from './BaseWidget';
import { useTheme } from '@/hooks/useTheme';
import { useLiveSpace } from '@/context/LiveSpaceContext';
import { spacesService, type Space } from '@/services/spacesService';
import { useSpaceUsers, getDisplayName } from '@/hooks/useSpaceUsers';
import { useUserById } from '@/stores/usersStore';
import { Agora as SpacesIcon } from '@mention/agora-shared';
import { Loading } from '@/components/ui/Loading';

const MAX_SPACES_DISPLAYED = 3;
const REFRESH_INTERVAL_MS = 30_000;

const SpaceRow = React.memo(function SpaceRow({
  space,
  isLast,
  onPress,
}: {
  space: Space;
  isLast: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const hostProfile = useUserById(space.host);
  const hostName = hostProfile?.username
    ? `@${hostProfile.username}`
    : getDisplayName(hostProfile, space.host);
  const listenerCount = space.participants?.length || 0;

  return (
    <TouchableOpacity
      style={[
        styles.spaceItem,
        !isLast && { borderBottomWidth: 0.5, borderBottomColor: theme.colors.border },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.spaceContent}>
        <View style={styles.liveDot} />
        <View style={styles.spaceTextContainer}>
          <Text
            style={[styles.spaceTitle, { color: theme.colors.text }]}
            numberOfLines={1}
          >
            {space.title}
          </Text>
          <View style={styles.spaceMeta}>
            <Ionicons name="headset-outline" size={11} color={theme.colors.textSecondary} />
            <Text style={[styles.spaceMetaText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {listenerCount} listening  ·  {hostName}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
});

export function LiveSpacesWidget() {
  const { isAuthenticated } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const { joinLiveSpace } = useLiveSpace();

  const [spaces, setSpaces] = useState<Space[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLiveSpaces = useCallback(async (silent = false) => {
    if (!isAuthenticated) return;
    if (!silent) {
      setIsLoading(true);
      setError(null);
    }
    try {
      const liveSpaces = await spacesService.getSpaces('live');
      setSpaces(liveSpaces);
      if (!silent) setIsLoading(false);
    } catch (err: any) {
      if (!silent) {
        setError(err?.message || 'Failed to load live spaces');
        setIsLoading(false);
      }
    }
  }, [isAuthenticated]);

  useEffect(() => {
    let mounted = true;

    const fetch = async (silent = false) => {
      if (!isAuthenticated) return;
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      try {
        const liveSpaces = await spacesService.getSpaces('live');
        if (mounted) {
          setSpaces(liveSpaces);
          if (!silent) setIsLoading(false);
        }
      } catch (err: any) {
        if (mounted && !silent) {
          setError(err?.message || 'Failed to load live spaces');
          setIsLoading(false);
        }
      }
    };

    fetch();
    const id = setInterval(() => fetch(true), REFRESH_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [isAuthenticated]);

  const displayedSpaces = useMemo(
    () => spaces.slice(0, MAX_SPACES_DISPLAYED),
    [spaces],
  );

  const hostIds = useMemo(
    () => displayedSpaces.map((s) => s.host).filter(Boolean),
    [displayedSpaces],
  );
  useSpaceUsers(hostIds);

  const handleShowMore = useCallback(() => {
    router.push('/spaces' as any);
  }, [router]);

  if (!isAuthenticated) return null;
  if (!isLoading && !error && spaces.length === 0) return null;

  return (
    <BaseWidget
      title="Live Spaces"
      icon={<SpacesIcon size={18} color={theme.colors.text} />}
    >
      {isLoading ? (
        <View style={styles.centerRow}>
          <Loading size="small" style={{ flex: undefined }} />
          <Text style={[styles.muted, { color: theme.colors.textSecondary }]}>
            Loading spaces…
          </Text>
        </View>
      ) : error ? (
        <Text style={{ color: theme.colors.error }}>{error}</Text>
      ) : (
        <View style={styles.listContainer}>
          {displayedSpaces.map((space, index) => (
            <SpaceRow
              key={space._id}
              space={space}
              isLast={index === displayedSpaces.length - 1}
              onPress={() => joinLiveSpace(space._id)}
            />
          ))}
          <TouchableOpacity
            style={styles.showMore}
            onPress={handleShowMore}
            activeOpacity={0.7}
          >
            <Text style={[styles.showMoreText, { color: theme.colors.primary }]}>
              Show more
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  muted: {
    fontSize: 13,
  },
  listContainer: {},
  spaceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    ...Platform.select({ web: { cursor: 'pointer' as const } }),
  },
  spaceContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FF4458',
  },
  spaceTextContainer: {
    flex: 1,
  },
  spaceTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  spaceMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 1,
  },
  spaceMetaText: {
    fontSize: 12,
    flex: 1,
  },
  showMore: {
    ...Platform.select({ web: { cursor: 'pointer' as const } }),
  },
  showMoreText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
