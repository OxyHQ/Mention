import React, { useMemo, useCallback } from "react";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { FollowButton } from "@oxyhq/services";
import { Avatar } from '@oxyhq/bloom/avatar';
import { ThemedText } from "@/components/ThemedText";
import { BaseWidget } from "./BaseWidget";
import { useUserById } from "@/hooks/useCachedUser";
import { getUserPlaceholderColor } from "@/utils/userPlaceholderColor";
import UserName from '@/components/UserName';
import { useRecommendations } from '@/hooks/useRecommendations';
import { type ProfileData } from '@/lib/recommendations';
import { getNormalizedUserHandle } from '@oxyhq/core';

const MAX_DISPLAY_USERS = 5;

export function WhoToFollowWidget({ divider }: { divider?: boolean }) {
  const { t } = useTranslation();
  const router = useRouter();

  // Shared cache: this widget reads a small slice of the same recommendations
  // entry the explore tab and other surfaces use, so it never re-fetches per mount.
  const { recommendations, isLoading: loading, error } = useRecommendations();

  const handleShowMore = useCallback(() => {
    router.push("/explore/who-to-follow");
  }, [router]);

  const displayedUsers = useMemo(
    () => recommendations.slice(0, MAX_DISPLAY_USERS),
    [recommendations]
  );

  if (loading) {
    return (
      <BaseWidget title={t("Who to follow")} divider={divider}>
        <View className="gap-2 py-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton.Row key={i} style={{ alignItems: 'center', gap: 10 }}>
              <Skeleton.Circle size={34} />
              <Skeleton.Col>
                <Skeleton.Text style={{ fontSize: 14, lineHeight: 16, width: 120 }} />
                <Skeleton.Text style={{ fontSize: 12, lineHeight: 14, width: 90 }} />
              </Skeleton.Col>
              <Skeleton.Pill size={16} style={{ marginLeft: 'auto' }} />
            </Skeleton.Row>
          ))}
        </View>
      </BaseWidget>
    );
  }

  if (error) {
    return (
      <BaseWidget title={t("Who to follow")} divider={divider}>
        <View className="py-2 items-center gap-2">
          <ThemedText className="text-destructive text-[13px]">
            {error.message}
          </ThemedText>
        </View>
      </BaseWidget>
    );
  }

  if (displayedUsers.length === 0) {
    return (
      <BaseWidget title={t("Who to follow")} divider={divider}>
        <View className="py-2 items-center">
          <ThemedText className="text-muted-foreground">
            {t("No recommendations available")}
          </ThemedText>
        </View>
      </BaseWidget>
    );
  }

  return (
    <BaseWidget title={t("Who to follow")} divider={divider}>
      <View className="gap-2">
        <View>
          {displayedUsers.map((user, index) => (
            <FollowRowComponent
              key={user.id}
              profileData={user}
              showBorder={index < displayedUsers.length - 1}
            />
          ))}
        </View>
        <TouchableOpacity
          style={styles.webCursor}
          onPress={handleShowMore}
          activeOpacity={0.7}
        >
          <ThemedText className="text-primary text-[14px] font-medium">
            {t("Show more")}
          </ThemedText>
        </TouchableOpacity>
      </View>
    </BaseWidget>
  );
}

const FollowRowComponent = React.memo(({ profileData, showBorder = true }: { profileData: ProfileData; showBorder?: boolean }) => {
  const router = useRouter();
  const cachedUser = useUserById(profileData.id);

  const displayHandle = getNormalizedUserHandle(profileData);

  const handlePress = useCallback(() => {
    if (displayHandle) {
      router.push(`/@${displayHandle}`);
    }
  }, [router, displayHandle]);

  return (
    <View
      className="flex-row justify-between items-center border-border py-2"
      style={[styles.webCursor, showBorder && styles.itemBorder]}
    >
      <TouchableOpacity className="flex-row items-center flex-1" onPress={handlePress} disabled={!displayHandle} activeOpacity={0.7}>
        <Avatar source={profileData.avatar || cachedUser?.avatar} size={34} variant="thumb" placeholderColor={getUserPlaceholderColor(cachedUser)} />
        <View className="ml-2.5 flex-1 mr-2">
          <UserName
            name={profileData.name.displayName}
            isFederated={profileData.isFederated}
            isAgent={profileData.isAgent}
            isAutomated={profileData.isAutomated}
            variant="small"
            style={{ name: { fontSize: 14 } }}
          />
          <ThemedText className="text-muted-foreground text-[12px]" numberOfLines={1}>
          {displayHandle ? `@${displayHandle}` : '@unknown'}
          </ThemedText>
        </View>
      </TouchableOpacity>
      <FollowButton userId={profileData.id} size="small" />
    </View>
  );
});

FollowRowComponent.displayName = 'FollowRowComponent';

const styles = StyleSheet.create({
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  itemBorder: { borderBottomWidth: 0.5 },
});
