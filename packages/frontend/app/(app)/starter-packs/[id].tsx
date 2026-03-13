import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { useLocalSearchParams, router } from 'expo-router';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { starterPacksService } from '@/services/starterPacksService';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@oxyhq/services';
import { useHaptics } from '@/hooks/useHaptics';
import { Ionicons } from '@expo/vector-icons';
import Avatar from '@/components/Avatar';
import { ResponsiveAvatarStack } from '@/components/AvatarStack';
import SEO from '@/components/SEO';
import { cn } from '@/lib/utils';
import { formatCompactNumber } from '@/utils/formatNumber';
import { toast } from '@/lib/sonner';

interface MemberProfile {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
}

type FollowState = 'idle' | 'processing' | 'complete';

export default function StarterPackDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const { user, oxyServices } = useAuth();
  const haptics = useHaptics();
  const [pack, setPack] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [followState, setFollowState] = useState<FollowState>('idle');

  const isOwner = pack && user?.id === pack.ownerOxyUserId;

  useEffect(() => {
    (async () => {
      try {
        const p = await starterPacksService.get(String(id));
        setPack(p);

        if (p.memberOxyUserIds?.length) {
          const profiles = await Promise.all(
            p.memberOxyUserIds.map(async (uid: string): Promise<MemberProfile> => {
              try {
                const profile = await oxyServices.getUserById(uid);
                if (profile) {
                  return {
                    id: uid,
                    username: (profile as any).username || (profile as any).name?.full || uid,
                    displayName: (profile as any).name?.full || (profile as any).displayName,
                    avatar: (profile as any).avatar,
                  };
                }
              } catch { /* ignore individual failures */ }
              return { id: uid, username: uid };
            }),
          );
          setMembers(profiles);
        }
      } catch {
        setError('Failed to load starter pack');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const handleFollowAll = useCallback(async () => {
    if (!pack || followState !== 'idle') return;
    setFollowState('processing');

    try {
      const result = await starterPacksService.use(String(id));
      const userIds = result.memberOxyUserIds || [];

      // Follow all members in parallel — individual failures silently skipped
      // (user may already be following them)
      await Promise.allSettled(
        userIds.map((uid: string) => oxyServices.followUser(uid)),
      );

      setPack((prev: any) =>
        prev ? { ...prev, useCount: result.useCount } : prev,
      );
      setFollowState('complete');
      haptics('Medium');
      toast.success('All accounts have been followed!');
    } catch {
      setFollowState('idle');
      toast.error('Failed to follow accounts');
    }
  }, [pack, id, followState, oxyServices, haptics]);

  const handleDelete = useCallback(async () => {
    try {
      await starterPacksService.remove(String(id));
      router.replace('/starter-packs');
    } catch {
      toast.error('Failed to delete starter pack');
    }
  }, [id]);

  const memberAvatars = members
    .filter((m) => m.avatar)
    .map((m) => m.avatar!);

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
              <IconButton variant="icon" key="back" onPress={() => router.back()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
            rightComponents: isOwner
              ? [
                  <TouchableOpacity key="delete" onPress={handleDelete}>
                    <ThemedText className="text-destructive font-semibold">
                      Delete
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
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : pack ? (
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Hero section with avatar stack */}
            <View className="items-center px-6 pt-6 pb-4 gap-4">
              {memberAvatars.length > 0 ? (
                <View style={styles.avatarStackContainer}>
                  <ResponsiveAvatarStack
                    avatars={memberAvatars}
                    total={members.length}
                    maxDisplay={8}
                  />
                </View>
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

              {/* Follow all button — 3 states: idle, processing, complete */}
              {!isOwner && (
                <TouchableOpacity
                  disabled={followState !== 'idle'}
                  onPress={handleFollowAll}
                  className={cn(
                    'mt-2 py-3.5 px-8 rounded-3xl min-w-[220px] items-center flex-row justify-center gap-2',
                    followState === 'complete' ? 'bg-muted-foreground' : 'bg-primary',
                    followState !== 'idle' && 'opacity-70',
                  )}
                  accessibilityRole="button"
                  accessibilityLabel={
                    followState === 'complete'
                      ? 'All accounts followed'
                      : followState === 'processing'
                        ? 'Following accounts'
                        : 'Follow all accounts in this starter pack'
                  }>
                  {followState === 'processing' ? (
                    <>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text className="text-white font-bold text-base">
                        Following...
                      </Text>
                    </>
                  ) : followState === 'complete' ? (
                    <>
                      <Ionicons name="checkmark" size={18} color="#fff" />
                      <Text className="text-white font-bold text-base">
                        Done!
                      </Text>
                    </>
                  ) : (
                    <Text className="text-white font-bold text-base">
                      Follow all
                    </Text>
                  )}
                </TouchableOpacity>
              )}

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
                  onPress={() => router.push(`/@${m.username}` as never)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${m.displayName || m.username}, @${m.username}`}>
                  <Avatar source={m.avatar} size={44} />
                  <View className="flex-1 gap-0.5">
                    {m.displayName && (
                      <ThemedText
                        className="text-[15px] font-semibold"
                        numberOfLines={1}>
                        {m.displayName}
                      </ThemedText>
                    )}
                    <ThemedText
                      className="text-sm text-muted-foreground"
                      numberOfLines={1}>
                      @{m.username}
                    </ThemedText>
                  </View>
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
  avatarStackContainer: {
    width: '100%',
    paddingHorizontal: 16,
    alignItems: 'center',
  },
});
