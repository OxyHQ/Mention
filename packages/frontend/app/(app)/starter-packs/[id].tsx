import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, ScrollView, Platform } from 'react-native';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { useLocalSearchParams, useFocusEffect, router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { starterPacksService } from '@/services/starterPacksService';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth, FollowButton } from '@oxy.so/services/ui/client';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { AvatarGroup, type AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { RiLineChartLine } from '@oxy.so/bloom/icons';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { ProfileCard } from '@/components/ProfileCard';

import { SEO } from '@/components/SEO';
import { formatCompactNumber } from '@/utils/formatNumber';
import { displayNameOrHandle } from '@/utils/displayName';
import { logger } from '@oxy.so/core/logger';
import { StarterPackIcon } from '@/assets/icons/starter-pack-icon';

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
  /** Members hydrated server-side: identity + fully-resolved avatar URL. */
  members?: { id: string; username: string; displayName?: string; avatar?: string }[];
  memberCount?: number;
}

export default function StarterPackDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const { user } = useAuth();
  const safeBack = useSafeBack();
  const { t } = useTranslation();
  const haptics = useHaptics();
  const [pack, setPack] = useState<StarterPackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberProfile[]>([]);

  const isOwner = pack ? user?.id === pack.ownerOxyUserId : false;

  const load = useCallback(async () => {
    // Show the spinner on every (re)run (e.g. a refocus refetch) so it replaces
    // any stale error/empty state instead of leaving the previous one on screen.
    setLoading(true);
    setError(null);
    try {
      const p = await starterPacksService.get(String(id)) as StarterPackDetail;
      setPack(p);
      // Members arrive already hydrated (identity + fully-resolved avatar URL)
      // from the backend, which owns the service credential for the bulk user
      // lookup. The browser client cannot resolve them itself, so we render the
      // server-provided members directly.
      setMembers(
        (p.members ?? []).map((m) => ({
          id: m.id,
          username: m.username,
          displayName: displayNameOrHandle(m.displayName, m.username),
          avatar: m.avatar ?? undefined,
        })),
      );
    } catch (e) {
      logger.warn('Failed to load starter pack', { error: e });
      setError('Failed to load starter pack');
    } finally {
      setLoading(false);
    }
    // The detail read is a public (optional-auth) endpoint and returns the same
    // hydrated members anonymously, so it does not need to re-run on the SSO
    // session landing. `isOwner` (Edit button) and the FollowButtons read auth
    // state reactively on their own.
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // "Follow all" delegates the actual following to the multi-mode FollowButton;
  // once the bulk follow lands we record pack usage (increments useCount) and
  // reflect the new count in the UI.
  const handleBulkFollow = useCallback(async () => {
    haptics('medium');
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

  const packBody = pack ? (
    <>
      {/* Hero section with grouped member avatars */}
      <View className="items-center px-6 pt-6 pb-4 gap-4">
        {avatarItems.length > 0 ? (
          <AvatarGroup items={avatarItems} size={56} max={8} total={members.length} variant={MEDIA_VARIANT_AVATAR_LG} />
        ) : (
          <View className="w-16 h-16 rounded-2xl items-center justify-center bg-primary/20">
            <StarterPackIcon size={32} color={theme.colors.primary} />
          </View>
        )}

        <Text className="text-[22px] leading-6 font-bold text-center text-foreground" numberOfLines={2}>
          {pack.name}
        </Text>

        {pack.description && (
          <Text className="text-[15px] leading-[22px] text-center text-muted-foreground">
            {pack.description}
          </Text>
        )}

        <Text className="text-sm leading-6 text-muted-foreground">
          {members.length} {members.length === 1 ? 'account' : 'accounts'}
          {pack.useCount > 0
            ? ` \u00B7 Used by ${formatCompactNumber(pack.useCount)} ${pack.useCount === 1 ? 'person' : 'people'}`
            : ''}
        </Text>

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
            <RiLineChartLine width={14} height={14} fill={theme.colors.textSecondary} />
            <Text className="text-sm leading-6 font-semibold text-muted-foreground">
              {formatCompactNumber(pack.useCount)} joined
            </Text>
          </View>
        )}
      </View>

      {/* Member list — rows are full-bleed, so only the section title is inset. */}
      <View className="pt-2 pb-8">
        <Text className="text-base leading-6 font-bold mb-3 px-4 text-foreground">
          Accounts in this pack
        </Text>
        {/* The shared user row; its follow button renders nothing on the viewer's own row. */}
        {members.map((m) => (
          <ProfileCard
            key={m.id}
            profile={{
              id: m.id,
              username: m.username,
              name: { displayName: m.displayName },
              avatar: m.avatar,
            }}
            showFollowButton
          />
        ))}
      </View>
    </>
  ) : null;

  return (
    <>
      <SEO
        title={pack?.name || 'Starter Pack'}
        description={pack?.description || 'A curated collection of accounts to follow'}
      />
      <View className="flex-1">
        <PageHeader
          title={pack?.name || 'Starter Pack'}
          onBack={() => safeBack()}
          backLabel={t('common.back', { defaultValue: 'Back' })}
          actions={
            isOwner ? (
              <Button variant="text" onPress={handleEdit} accessibilityLabel="Edit starter pack">
                Edit
              </Button>
            ) : undefined
          }
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
          // WEB hands scroll to the shared panel/document (no nested scroller that
          // would break sticky rails + window scroll restoration); NATIVE keeps a
          // ScrollView as the screen's scroller — the standard RN idiom.
          Platform.OS === 'web' ? (
            <View>{packBody}</View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>{packBody}</ScrollView>
          )
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  followAllButton: {
    marginTop: 8,
    minWidth: 220,
  },
});
