import React, { useMemo, useCallback } from "react";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { ThemedText } from "@/components/ThemedText";
import { ProfileCard, ProfileCardSkeletonList, type ProfileCardData } from "@/components/ProfileCard";
import { BaseWidget } from "./BaseWidget";
import { useUserById } from "@/hooks/useCachedUser";
import { useRecommendations } from '@/hooks/useRecommendations';
import { type ProfileData } from '@/lib/recommendations';

const MAX_DISPLAY_USERS = 5;

/** Placeholder rows while the recommendations load. */
const SKELETON_ROW_COUNT = 3;

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
        {/* Same inset as the real rows below, so nothing shifts when they land. */}
        <View className="-mx-3">
          <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton />
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
        {/* The rows are the same full-width ProfileCard used across the app; the
            negative inset lets them bleed to the widget's edges (the widget's own
            horizontal padding would otherwise double up with the row's). */}
        <View className="-mx-3">
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
  const cachedUser = useUserById(profileData.id);

  // The rail row omits the bio — the sidebar has no room for it. Everything else
  // (identity, badges, follow button) is the shared row's.
  const profile: ProfileCardData = {
    id: profileData.id,
    username: profileData.username || cachedUser?.username || '',
    name: profileData.name,
    avatar: profileData.avatar || cachedUser?.avatar,
    color: cachedUser?.color,
    verified: profileData.verified,
    isFederated: profileData.isFederated,
    isAgent: profileData.isAgent,
    isAutomated: profileData.isAutomated,
    instance: profileData.instance,
    federation: profileData.federation,
  };

  return <ProfileCard profile={profile} showFollowButton showDivider={showBorder} />;
});

FollowRowComponent.displayName = 'FollowRowComponent';

const styles = StyleSheet.create({
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
});
