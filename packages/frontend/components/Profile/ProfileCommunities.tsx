import { memo, useCallback } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import type { ProfileCommunitiesProps, Community } from './types';

import {
  Embed,
  HStack,
  Image,
  RawText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

/** A community's icon is a 100pt square. */
const card = defineTokens({ space: { icon: 100 } });

/**
 * Profile communities section
 * Displays communities the user is a member of
 */
export const ProfileCommunities = memo(function ProfileCommunities({
  communities,
}: ProfileCommunitiesProps) {
  const { t } = useTranslation();

  if (!communities || communities.length === 0) {
    return null;
  }

  return toElement(
    VStack(
      RawText(t('profile.communities'))
        .foreground('foreground')
        .font('14')
        .leading('20px')
        .weight('bold')
        .margin('bottom', 'md'),
      Embed(
        communities.map((community, index) => (
          <CommunityCard key={community.id || index} community={community} />
        )),
      ),
    ).margin('top', 'lg'),
  );
});

const CommunityCard = memo(function CommunityCard({ community }: { community: Community }) {
  const router = useRouter();
  const { t } = useTranslation();

  const handleViewPress = useCallback(() => {
    if (community.id) {
      router.push(`/community/${community.id}`);
    }
  }, [community.id, router]);

  return toElement(
    VStack(
      HStack(
        community.icon
          ? VStack(Image(community.icon).contentFit('cover').flex('1').clipped())
              .frame({ width: card.space.icon, height: card.space.icon })
              .corner('lg')
              .clipped()
          : null,
        VStack(
          RawText(community.name)
            .foreground('foreground')
            .font('16')
            .leading('normal')
            .weight('bold')
            .margin('bottom', 'xs'),
          community.description
            ? RawText(community.description)
                .foreground('muted')
                .font('14')
                .leading('18px')
                .margin('bottom', 'sm')
            : null,
          community.memberCount
            ? HStack(
                RawText(
                  t('profile.memberCount', {
                    count: community.memberCount,
                    defaultValue: `${community.memberCount} Members`,
                  }),
                )
                  .foreground('muted')
                  .font('sm'),
              )
                .align('center')
                .margin('bottom', 'md')
            : null,
        ).flex('1'),
      )
        .margin('bottom', 'md')
        .spacing('md'),
      VStack(
        RawText(t('profile.view'))
          .foreground('primary')
          .font('md')
          .weight('semibold')
          .textAlign('center'),
      )
        .padding('horizontal', 'lg')
        .padding('vertical', '6')
        .frame({ width: 'full' })
        .alignSelf('center')
        .margin('top', '10')
        .onPress(handleViewPress)
        .pressFade(),
    )
      .padding('all', 'md')
      .background('mutedFill')
      .border('border', 'thin')
      .corner('md')
      .margin('bottom', 'md'),
  );
});
