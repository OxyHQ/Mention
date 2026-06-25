import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { useLocalSearchParams, useFocusEffect, router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { starterPacksService } from '@/services/starterPacksService';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth, FollowButton, queryKeys } from '@oxyhq/services';
import { useHaptics } from '@/hooks/useHaptics';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { AvatarGroup, type AvatarGroupItem } from '@oxyhq/bloom/avatar-group';

import SEO from '@/components/SEO';
import { formatCompactNumber } from '@/utils/formatNumber';
import { logger } from '@/lib/logger';
import { queryClient } from '@/lib/queryClient';
import { getNormalizedUserHandle, type User } from '@oxyhq/core';

interface MemberProfile {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
}

interface StarterPackDetail {
  name: string;
  description?: string;
  memberOxyUserIds?: string[];
  ownerOxyUserId?: string;
  useCount: number;
}

export default function StarterPackDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const { user, oxyServices } = useAuth();
  const safeBack = useSafeBack();
  const haptics = useHaptics();
  const [pack, setPack] = useState<StarterPackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberProfile[]>([]);

  const isOwner = pack ? user?.id === pack.ownerOxyUserId : false;

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = await starterPacksService.get(String(id)) as StarterPackDetail;
      setPack(p);

      if (p.memberOxyUserIds?.length) {
        // Single bulk fetch (no per-id N+1); prime the shared React Query cache
        // so downstream profile reads for these members hit the cache.
        const fetched = await oxyServices.getUsersByIds(p.memberOxyUserIds);
        for (const profile of fetched) {
          if (profile?.id) {
            queryClient.setQueryData(queryKeys.users.detail(profile.id), profile);
          }
        }
        const byId = new Map(fetched.map((profile) => [profile.id, profile]));
        const profiles = p.memberOxyUserIds
          .map((uid) => byId.get(uid))
          .filter((profile): profile is User => Boolean(profile))
          .map((profile) => ({
            id: profile.id,
            username: profile.username,
            displayName: profile.name.displayName,
            avatar: profile.avatar ?? undefined,
          }));
        setMembers(profiles);
      } else {
        setMembers([]);
      }
    } catch (e) {
      logger.warn('Failed to load starter pack', { error: e });
      setError('Failed to load starter pack');
    } finally {
      setLoading(false);
    }
  }, [id, oxyServices]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // "Follow all" delegates the actual following to the multi-mode FollowButton;
  // once the bulk follow lands we record pack usage (increments useCount) and
  // reflect the new count in the UI.
  const handleBulkFollow = useCallback(async () => {
    haptics('Medium');
    try {
      const used = await starterPacksService.use(String(id));
      setPack((prev) => (prev ? { ...prev, useCount: used.useCount } : prev));
    } catch (e) {
      logger.warn('Failed to record starter pack usage', { error: e, id });
    }
  }, [id, haptics]);

  const handleEdit = useCallback(() => {
    router.push(`/starter-packs/${String(id)}/edit`);
  }, [id]);

  const avatarItems = useMemo<AvatarGroupItem[]>(
    () =>
      members.map((m) => ({
        id: m.id,
        uri: m.avatar,
        displayName: m.displayName,
        username: m.username,
      })),
    [members],
  );

  // All member ids; the FollowButton drops the viewer's own id and dedupes.
  const followAllUserIds = useMemo(() => members.map((m) => m.id), [members]);

  return (
    <>
      <SEO
        title={pack?.name || 'Starter Pack'}
        description={pack?.description || 'A curated collection of accounts to follow'}
      />
      <ThemedView className="flex-1">
        <Header
          options={{
            title: pack?.name || 'Starter Pack',
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
            rightComponents: isOwner
              ? [
                  <TouchableOpacity
                    key="edit"
                    onPress={handleEdit}
                    accessibilityRole="button"
                    accessibilityLabel="Edit starter pack">
                    <ThemedText className="text-primary font-semibold">
                      Edit
                    </ThemedText>
                  </TouchableOpacity>,
                ]
              : [],
          }}
          hideBottomBorder={true}
          disableSticky={true}
        />

        {error ? (
          <View className="flex-1 items-center justify-center">
            <Text className="text-destructive">{error}</Text>
          </View>
        ) : loading ? (
          <View className="flex-1 items-center justify-center">
            <SpinnerIcon size={28} className="text-primary" />
          </View>
        ) : pack ? (
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Hero section with grouped member avatars */}
            <View className="items-center px-6 pt-6 pb-4 gap-4">
              {avatarItems.length > 0 ? (
                <AvatarGroup items={avatarItems} size={56} max={8} total={members.length} />
              ) : (
                <View className="w-16 h-16 rounded-2xl items-center justify-center bg-primary/20">
                  <Ionicons name="rocket-outline" size={32} color={theme.colors.primary} />
                </View>
              )}

              <ThemedText className="text-[22px] font-bold text-center" numberOfLines={2}>
                {pack.name}
              </ThemedText>

              {pack.description && (
                <ThemedText className="text-[15px] leading-[22px] text-center text-muted-foreground">
                  {pack.description}
                </ThemedText>
              )}

              <ThemedText className="text-sm text-muted-foreground">
                {members.length} {members.length === 1 ? 'account' : 'accounts'}
                {pack.useCount > 0
                  ? ` \u00B7 Used by ${formatCompactNumber(pack.useCount)} ${pack.useCount === 1 ? 'person' : 'people'}`
                  : ''}
              </ThemedText>

              {/* Follow-all: multi-mode FollowButton drops the viewer's own id,
                  self-gates on private-API readiness, and records pack usage on
                  success. Renders null when no other members remain. */}
              <FollowButton
                userIds={followAllUserIds}
                size="large"
                followAllLabel="Follow all"
                followedAllLabel="Following all"
                onBulkFollow={handleBulkFollow}
                style={styles.followAllButton}
              />

              {/* Joined count — only show for popular packs (>= 50) */}
              {pack.useCount >= 50 && (
                <View className="flex-row items-center gap-1.5 mt-1">
                  <Ionicons name="trending-up" size={14} color={theme.colors.textSecondary} />
                  <ThemedText className="text-sm font-semibold text-muted-foreground">
                    {formatCompactNumber(pack.useCount)} joined
                  </ThemedText>
                </View>
              )}
            </View>

            {/* Member list */}
            <View className="px-4 pt-2 pb-8">
              <ThemedText className="text-base font-bold mb-3">
                Accounts in this pack
              </ThemedText>
              {members.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    className="flex-row items-center py-3 border-b border-border gap-3"
                    onPress={() => {
                      const handle = getNormalizedUserHandle({ username: m.username });
                      if (handle) {
                        router.push(`/@${handle}`);
                      }
                    }}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`${m.displayName}, @${m.username}`}>
                    <Avatar source={m.avatar} size={44} />
                    <View className="flex-1 gap-0.5">
                      <ThemedText
                        className="text-[15px] font-semibold"
                        numberOfLines={1}>
                        {m.displayName}
                      </ThemedText>
                      <ThemedText
                        className="text-sm text-muted-foreground"
                        numberOfLines={1}>
                        @{m.username}
                      </ThemedText>
                    </View>
                    {/* Per-member follow; FollowButton returns null on the viewer's own row. */}
                    <FollowButton userId={m.id} size="small" />
                  </TouchableOpacity>
                ))}
            </View>
          </ScrollView>
        ) : null}
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  followAllButton: {
    marginTop: 8,
    minWidth: 220,
  },
});
