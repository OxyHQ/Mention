import { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import type { ProfileCommunitiesProps, Community } from './types';

import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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
        Embed(
          community.icon && (
            <View className="rounded-lg overflow-hidden" style={{ width: 100, height: 100 }}>
              <Image
                source={{ uri: community.icon }}
                resizeMode="cover"
                className="flex-1 overflow-hidden"
              />
            </View>
          ),
        ),
        VStack(
          RawText(community.name)
            .foreground('foreground')
            .font('16')
            .leading('normal')
            .weight('bold')
            .margin('bottom', 'xs'),
          Embed(
            community.description && (
              <Text className="text-muted-foreground text-sm mb-2" style={{ lineHeight: 18 }}>
                {community.description}
              </Text>
            ),
          ),
          Embed(
            community.memberCount &&
              toElement(
                HStack(
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
                  .margin('bottom', 'md'),
              ),
          ),
        ).flex('1'),
      )
        .margin('bottom', 'md')
        .spacing('md'),
      Embed(
        <TouchableOpacity
          className="self-center w-full mt-2.5 px-4 py-1.5"
          onPress={handleViewPress}
        >
          {toElement(
            RawText(t('profile.view'))
              .foreground('primary')
              .font('md')
              .weight('semibold')
              .textAlign('center'),
          )}
        </TouchableOpacity>,
      ),
    )
      .padding('all', 'md')
      .background('mutedFill')
      .border('border', 'thin')
      .corner('md')
      .margin('bottom', 'md'),
  );
});
