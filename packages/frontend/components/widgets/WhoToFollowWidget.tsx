import { Button } from '@oxy.so/bloom/button';
import React, { useMemo, useCallback } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
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
        <View>
          <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton size="small" horizontalInset={0} showDivider={false} />
        </View>
      </BaseWidget>
    );
  }

  // A failed fetch leaves the rail with nothing to suggest, which is the same
  // situation as an empty result — the widget disappears instead of turning the
  // rail into an error report.
  if (error || displayedUsers.length === 0) {
    return null;
  }

  return (
    <BaseWidget title={t("Who to follow")} divider={divider}>
      <View className="gap-2">
        {/* Compact Bloom rows align directly with the widget heading. */}
        <View>
          {displayedUsers.map((user) => (
            <FollowRowComponent
              key={user.id}
              profileData={user}
              showBorder={false}
            />
          ))}
        </View>
        <Button appearance="plain" size="small" onPress={handleShowMore} style={{ alignSelf: 'flex-start' }}>
          {t("Show more")}
        </Button>
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

  return <ProfileCard profile={profile} showFollowButton showDivider={showBorder} size="small" horizontalInset={0} />;
});

FollowRowComponent.displayName = 'FollowRowComponent';
