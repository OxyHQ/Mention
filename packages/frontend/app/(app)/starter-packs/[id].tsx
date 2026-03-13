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
import { Ionicons } from '@expo/vector-icons';
import Avatar from '@/components/Avatar';
import SEO from '@/components/SEO';
import { cn } from '@/lib/utils';

interface MemberProfile {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
}

export default function StarterPackDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const { user, oxyServices } = useAuth();
  const [pack, setPack] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [using, setUsing] = useState(false);
  const [useComplete, setUseComplete] = useState(false);
  const [followProgress, setFollowProgress] = useState({ current: 0, total: 0 });

  const isOwner = pack && user?.id === pack.ownerOxyUserId;

  // Load pack data
  useEffect(() => {
    (async () => {
      try {
        const p = await starterPacksService.get(String(id));
        setPack(p);

        // Hydrate member profiles in parallel
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
              } catch { /* ignore */ }
              return { id: uid, username: uid };
            })
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

  // Use the starter pack — follow all members
  const handleUse = useCallback(async () => {
    if (!pack || using) return;
    setUsing(true);
    try {
      const result = await starterPacksService.use(String(id));
      const userIds = result.memberOxyUserIds || [];
      setFollowProgress({ current: 0, total: userIds.length });

      for (let i = 0; i < userIds.length; i++) {
        try {
          await oxyServices.followUser(userIds[i]);
        } catch {
          // Skip users that fail (may already be following)
        }
        setFollowProgress({ current: i + 1, total: userIds.length });
      }

      setPack((prev: any) => prev ? { ...prev, useCount: result.useCount } : prev);
      setUseComplete(true);
    } catch (e) {
      console.error('Failed to use starter pack', e);
    } finally {
      setUsing(false);
    }
  }, [pack, id, using, oxyServices]);

  // Delete pack
  const handleDelete = useCallback(async () => {
    try {
      await starterPacksService.remove(String(id));
      router.replace('/starter-packs');
    } catch (e) {
      console.error('Failed to delete starter pack', e);
    }
  }, [id]);

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
              <IconButton variant="icon"
                key="back"
                onPress={() => router.back()}
              >
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
            rightComponents: isOwner ? [
              <TouchableOpacity key="delete" onPress={handleDelete}>
                <ThemedText className="text-destructive font-semibold">Delete</ThemedText>
              </TouchableOpacity>
            ] : [],
          }}
          hideBottomBorder={true}
          disableSticky={true}
        />

        {error ? (
          <View className="flex-1 items-center justify-center"><Text className="text-destructive">{error}</Text></View>
        ) : loading ? (
          <View className="flex-1 items-center justify-center"><ActivityIndicator /></View>
        ) : pack ? (
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Pack info */}
            <View className="items-center px-6 pt-6 pb-4">
              <View className="w-16 h-16 rounded-2xl items-center justify-center mb-4 bg-primary/20">
                <Ionicons name="rocket-outline" size={32} color={theme.colors.primary} />
              </View>
              <ThemedText className="text-[22px] font-bold text-center font-primary">{pack.name}</ThemedText>
              {pack.description && (
                <ThemedText className="text-[15px] leading-[22px] text-center mt-2 text-muted-foreground font-primary">
                  {pack.description}
                </ThemedText>
              )}
              <ThemedText className="text-sm mt-2 text-muted-foreground font-primary">
                {members.length} {members.length === 1 ? 'account' : 'accounts'}
                {pack.useCount > 0 ? ` · Used by ${pack.useCount} ${pack.useCount === 1 ? 'person' : 'people'}` : ''}
              </ThemedText>

              {/* Use button */}
              {!isOwner && (
                <TouchableOpacity
                  disabled={using || useComplete}
                  onPress={handleUse}
                  className={cn(
                    "mt-5 py-3.5 px-8 rounded-3xl min-w-[220px] items-center",
                    useComplete ? "bg-muted-foreground" : "bg-primary",
                    (using || useComplete) && "opacity-70"
                  )}
                >
                  <Text className="text-white font-bold text-base font-primary">
                    {useComplete
                      ? 'Done!'
                      : using
                        ? `Following ${followProgress.current} of ${followProgress.total}...`
                        : 'Use this Starter Pack'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Member list */}
            <View className="px-4 pt-2 pb-8">
              <ThemedText className="text-base font-bold mb-3 font-primary">Accounts in this pack</ThemedText>
              {members.map((m) => (
                <TouchableOpacity
                  key={m.id}
                  className="flex-row items-center py-3 border-b border-border gap-3"
                  onPress={() => router.push(`/${m.username}`)}
                  activeOpacity={0.7}
                >
                  <Avatar source={m.avatar} size={44} />
                  <View className="flex-1 gap-0.5">
                    {m.displayName && (
                      <ThemedText className="text-[15px] font-semibold font-primary" numberOfLines={1}>
                        {m.displayName}
                      </ThemedText>
                    )}
                    <ThemedText className="text-sm text-muted-foreground font-primary" numberOfLines={1}>
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
