import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { ProfileCommunitiesProps, Community } from './types';

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

  return (
    <View className="mt-4">
      <Text className="text-foreground text-sm font-bold mb-3">
        {t('profile.communities')}
      </Text>
      {communities.map((community, index) => (
        <CommunityCard key={community.id || index} community={community} />
      ))}
    </View>
  );
});

const CommunityCard = memo(function CommunityCard({ community }: { community: Community }) {
  const { t } = useTranslation();

  const handleViewPress = useCallback(() => {
    if (community.id) {
      router.push(`/community/${community.id}` as any);
    }
  }, [community.id]);

  return (
    <View className="bg-muted border border-border rounded-xl p-3 mb-3">
      <View className="flex-row mb-3">
        {community.icon && (
          <View className="rounded-lg mr-3 overflow-hidden" style={{ width: 100, height: 100 }}>
            <Image
              source={{ uri: community.icon }}
              resizeMode="cover"
              className="flex-1 overflow-hidden"
            />
          </View>
        )}
        <View className="flex-1">
          <Text className="text-foreground text-base font-bold mb-1">
            {community.name}
          </Text>
          {community.description && (
            <Text className="text-muted-foreground text-sm mb-2" style={{ lineHeight: 18 }}>
              {community.description}
            </Text>
          )}
          {community.memberCount && (
            <View className="flex-row items-center mb-3">
              <Text className="text-muted-foreground text-[13px]">
                {t('profile.memberCount', {
                  count: community.memberCount,
                  defaultValue: `${community.memberCount} Members`,
                })}
              </Text>
            </View>
          )}
        </View>
      </View>
      <TouchableOpacity className="self-center w-full mt-2.5 px-4 py-1.5" onPress={handleViewPress}>
        <Text className="text-primary text-[15px] font-semibold text-center">
          {t('profile.view')}
        </Text>
      </TouchableOpacity>
    </View>
  );
});
