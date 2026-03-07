import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { useLocalSearchParams, router } from 'expo-router';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { colors } from '@/styles/colors';
import { FONT_FAMILIES } from '@/styles/typography';
import { starterPacksService } from '@/services/starterPacksService';
import { useTheme } from '@/hooks/useTheme';
import { useAuth, useFollow } from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import SEO from '@/components/SEO';

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

        // Hydrate member profiles
        if (p.memberOxyUserIds?.length) {
          const profiles: MemberProfile[] = [];
          for (const uid of p.memberOxyUserIds) {
            try {
              const profile = await oxyServices.getUserById(uid);
              if (profile) {
                profiles.push({
                  id: uid,
                  username: (profile as any).username || (profile as any).name?.full || uid,
                  displayName: (profile as any).name?.full || (profile as any).displayName,
                  avatar: (profile as any).avatar,
                });
              }
            } catch {
              profiles.push({ id: uid, username: uid });
            }
          }
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
      <ThemedView style={{ flex: 1 }}>
        <Header
          options={{
            title: pack?.name || 'Starter Pack',
            leftComponents: [
              <IconButton variant="icon"
                key="back"
                onPress={() => router.back()}
              >
                <BackArrowIcon size={20} color={theme.colors.text} />
              </IconButton>,
            ],
            rightComponents: isOwner ? [
              <TouchableOpacity key="delete" onPress={handleDelete}>
                <ThemedText style={{ color: colors.busy, fontWeight: '600' }}>Delete</ThemedText>
              </TouchableOpacity>
            ] : [],
          }}
          hideBottomBorder={true}
          disableSticky={true}
        />

        {error ? (
          <View style={styles.center}><Text style={{ color: colors.busy }}>{error}</Text></View>
        ) : loading ? (
          <View style={styles.center}><ActivityIndicator /></View>
        ) : pack ? (
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Pack info */}
            <View style={styles.packInfo}>
              <View style={[styles.iconBubble, { backgroundColor: theme.colors.primary + '20' }]}>
                <Text style={{ fontSize: 32 }}>🚀</Text>
              </View>
              <ThemedText style={styles.packName}>{pack.name}</ThemedText>
              {pack.description && (
                <ThemedText style={[styles.packDescription, { color: theme.colors.textSecondary }]}>
                  {pack.description}
                </ThemedText>
              )}
              <ThemedText style={[styles.packStats, { color: theme.colors.textSecondary }]}>
                {members.length} {members.length === 1 ? 'account' : 'accounts'}
                {pack.useCount > 0 ? ` · Used by ${pack.useCount} ${pack.useCount === 1 ? 'person' : 'people'}` : ''}
              </ThemedText>

              {/* Use button */}
              {!isOwner && (
                <TouchableOpacity
                  disabled={using || useComplete}
                  onPress={handleUse}
                  style={[
                    styles.useButton,
                    { backgroundColor: useComplete ? theme.colors.textSecondary : theme.colors.primary },
                    (using || useComplete) && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.useButtonText}>
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
            <View style={styles.memberList}>
              <ThemedText style={styles.sectionTitle}>Accounts in this pack</ThemedText>
              {members.map((m) => (
                <TouchableOpacity
                  key={m.id}
                  style={[styles.memberRow, { borderBottomColor: theme.colors.border }]}
                  onPress={() => router.push(`/${m.username}`)}
                  activeOpacity={0.7}
                >
                  <Avatar source={m.avatar} size={44} />
                  <View style={styles.memberInfo}>
                    {m.displayName && (
                      <ThemedText style={styles.memberDisplayName} numberOfLines={1}>
                        {m.displayName}
                      </ThemedText>
                    )}
                    <ThemedText style={[styles.memberUsername, { color: theme.colors.textSecondary }]} numberOfLines={1}>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  packInfo: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 16 },
  iconBubble: { width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  packName: { fontSize: 22, fontWeight: '700', textAlign: 'center', fontFamily: FONT_FAMILIES.primary },
  packDescription: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 8, fontFamily: FONT_FAMILIES.primary },
  packStats: { fontSize: 14, marginTop: 8, fontFamily: FONT_FAMILIES.primary },
  useButton: { marginTop: 20, paddingVertical: 14, paddingHorizontal: 32, borderRadius: 24, minWidth: 220, alignItems: 'center' },
  useButtonText: { color: '#fff', fontWeight: '700', fontSize: 16, fontFamily: FONT_FAMILIES.primary },
  memberList: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12, fontFamily: FONT_FAMILIES.primary },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  memberInfo: { flex: 1, gap: 2 },
  memberDisplayName: { fontSize: 15, fontWeight: '600', fontFamily: FONT_FAMILIES.primary },
  memberUsername: { fontSize: 14, fontFamily: FONT_FAMILIES.primary },
});
