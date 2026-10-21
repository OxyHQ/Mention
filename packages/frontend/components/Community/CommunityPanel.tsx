import { memo, useCallback, useMemo } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/lib/navigation/router';
import { AvatarGroup, type AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { Button } from '@oxy.so/bloom/button';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useCommunityModerators } from '@/hooks/useCommunities';
import { useOperatesAccount } from '@/components/Profile/hooks/useOperatesAccount';
import { profileHrefForUser } from '@/components/Profile/profileRoute';

const MODERATOR_AVATAR_SIZE = 24;
const MAX_MODERATOR_AVATARS = 5;

interface CommunityPanelProps {
  /** The community hosted here this page is for. */
  communityId: string;
}

/**
 * What a community hosted here adds to its page: who moderates it, a way to post
 * in it, and — for its moderators — the way to its moderators and its bans.
 *
 * The feed, the member count and the Join button are the ordinary profile's
 * (a community's posts are the profile feed's community branch, its members are
 * its followers). The moderators are Oxy's public list, the same one the
 * community's fediverse actor names in `attributedTo`; who may moderate is
 * `useOperatesAccount` — an active member of the community, the same rule the
 * server's `assertCanModerateCommunity` reads. Managing moderators is Oxy's
 * shared account-members surface, not a second implementation here.
 */
export const CommunityPanel = memo(function CommunityPanel({ communityId }: CommunityPanelProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { canUsePrivateApi, showBottomSheet } = useAuth();
  const { data: moderators = [] } = useCommunityModerators(communityId);
  const moderates = useOperatesAccount({ accountId: communityId, accountKind: 'community' });

  const moderatorItems = useMemo<AvatarGroupItem[]>(
    () =>
      moderators.map((moderator) => ({
        id: moderator.id,
        uri: moderator.avatar,
        displayName: moderator.name?.displayName,
        username: getNormalizedUserHandle(moderator) ?? undefined,
      })),
    [moderators],
  );

  const openModerator = useCallback(
    (item: AvatarGroupItem) => {
      const moderator = moderators.find((candidate) => candidate.id === item.id);
      const href = profileHrefForUser(moderator);
      if (href) router.push(href);
    },
    [moderators, router],
  );

  const post = useCallback(
    () => router.push(`/compose?community=${encodeURIComponent(communityId)}`),
    [communityId, router],
  );
  const manageModerators = useCallback(
    () => showBottomSheet?.({ screen: 'AccountMembers', props: { accountId: communityId } }),
    [communityId, showBottomSheet],
  );
  const openBans = useCallback(
    () => router.push(`/communities/${encodeURIComponent(communityId)}/bans`),
    [communityId, router],
  );

  return (
    <View className="gap-3 mb-3">
      {moderatorItems.length > 0 && (
        <View className="flex-row items-center gap-2">
          <Text className="text-muted-foreground text-[13px]">
            {t('communities.moderatedBy', { defaultValue: 'Moderated by' })}
          </Text>
          <AvatarGroup
            items={moderatorItems}
            size={MODERATOR_AVATAR_SIZE}
            max={MAX_MODERATOR_AVATARS}
            total={moderatorItems.length}
            variant={MEDIA_VARIANT_AVATAR}
            onPressItem={openModerator}
          />
        </View>
      )}
      {canUsePrivateApi && (
        <View className="flex-row flex-wrap gap-2">
          <Button size="sm" leadingIcon={RiEditLine} onPress={post}>
            {t('communities.post', { defaultValue: 'Post in this community' })}
          </Button>
          {moderates && (
            <>
              <Button size="sm" appearance="subtle" tone="neutral" onPress={manageModerators}>
                {t('communities.manageModerators', { defaultValue: 'Moderators' })}
              </Button>
              <Button size="sm" appearance="subtle" tone="neutral" onPress={openBans}>
                {t('communities.bans', { defaultValue: 'Banned' })}
              </Button>
            </>
          )}
        </View>
      )}
    </View>
  );
});
