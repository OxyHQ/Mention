import { AccountAvatarGroup } from '@/components/ui/AccountAvatarGroup';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/lib/navigation/router';
import type { AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { useCommunityModerators } from '@/hooks/useCommunities';
import { useOperatesAccount } from '@/components/Profile/hooks/useOperatesAccount';
import { profileHrefForUser } from '@/components/Profile/profileRoute';

import {
  Button as LButton,
  Embed,
  HStack,
  Icon,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const MODERATOR_AVATAR_SIZE = 24;
const MAX_MODERATOR_AVATARS = 5;

interface CommunityPanelProps {
  /** The community this page is for. */
  communityId: string;
  /** Its handle, which its settings route is addressed by. */
  username: string;
  /**
   * Whether it is hosted HERE. A remote community (Lemmy, PieFed, Mbin) takes
   * posts from here too, but its moderators and bans are its own server's.
   */
  hosted: boolean;
}

/**
 * What a community adds to its page: a way to post in it and — for one hosted
 * here — who moderates it and, for its moderators, the way into its settings,
 * where its profile, moderators and bans are managed. A remote community's
 * moderation is its own server's.
 *
 * The feed, the member count and the Join button are the ordinary profile's
 * (a community's posts are the profile feed's community branch, its members are
 * its followers). The moderators are Oxy's public list, the same one the
 * community's fediverse actor names in `attributedTo`; who may moderate is
 * `useOperatesAccount` — an active member of the community, the same rule the
 * server's `assertCanModerateCommunity` reads.
 */
export const CommunityPanel = memo(function CommunityPanel({
  communityId,
  username,
  hosted,
}: CommunityPanelProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { canUsePrivateApi } = useAuth();
  const { data: moderators = [] } = useCommunityModerators(hosted ? communityId : null);
  const operates = useOperatesAccount({
    accountId: hosted ? communityId : null,
    accountKind: 'community',
  });
  const moderates = hosted && operates;

  const moderatorItems = useMemo<AvatarGroupItem[]>(
    () =>
      moderators.map((moderator) => ({
        id: moderator.id,
        uri: moderator.avatar,
        kind: moderator.kind,
        character: moderator.character,
        color: moderator.color,
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
  const openSettings = useCallback(() => {
    const href = profileHrefForUser({ username, kind: 'community' }, 'settings');
    if (href) router.push(href);
  }, [username, router]);

  return toElement(
    VStack(
      moderatorItems.length > 0
        ? HStack(
            RawText(t('communities.moderatedBy', { defaultValue: 'Moderated by' }))
              .foreground('muted')
              .font('sm'),
            Embed(
              <AccountAvatarGroup
                items={moderatorItems}
                size={MODERATOR_AVATAR_SIZE}
                max={MAX_MODERATOR_AVATARS}
                total={moderatorItems.length}
                variant={MEDIA_VARIANT_AVATAR}
                onPressItem={openModerator}
              />,
            ),
          )
            .align('center')
            .spacing('sm')
        : null,
      Embed(
        canUsePrivateApi &&
          toElement(
            HStack(
              LButton(
                Icon(RiEditLine),
                LText(t('communities.post', { defaultValue: 'Post in this community' })),
              )
                .size('sm')
                .onPress(post),
              Embed(
                moderates &&
                  toElement(
                    LButton(Icon(RiSettings3Line), LText(t('communities.settings.edit')))
                      .size('sm')
                      .style('subtle')
                      .tint('neutral')
                      .onPress(openSettings),
                  ),
              ),
            )
              .wrap()
              .spacing('sm'),
          ),
      ),
    )
      .spacing('md')
      .margin('bottom', 'md'),
  );
});
