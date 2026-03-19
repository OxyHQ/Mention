import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { useAuth } from "@oxyhq/services";
import * as OxyServicesNS from "@oxyhq/services";
import { Avatar } from '@oxyhq/bloom/avatar';
import { ThemedText } from "@/components/ThemedText";
import { BaseWidget } from "./BaseWidget";
import { useUsersStore } from "@/stores/usersStore";
import UserName from '@/components/UserName';
import { logger } from '@/lib/logger';
import { getRecommendationFilters } from '@/app/(app)/settings/privacy';

interface ProfileData {
  id: string;
  username?: string;
  name?: {
    first?: string;
    last?: string;
    full?: string;
  };
  avatar?: string;
  bio?: string;
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  instance?: string;
}

const MAX_DISPLAY_USERS = 5;

export function WhoToFollowWidget() {
  const { oxyServices, isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<ProfileData[]>([]);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    let mounted = true;

    const fetchRecommendations = async () => {
      try {
        setLoading(true);
        setError(null);
        const filters = await getRecommendationFilters();
        const excludeTypes: Array<'federated' | 'agent' | 'automated'> = [];
        if (!filters.showFederated) excludeTypes.push('federated');
        if (!filters.showAgents) excludeTypes.push('agent');
        if (!filters.showAutomated) excludeTypes.push('automated');
        const response = await oxyServices.getProfileRecommendations(
          excludeTypes.length > 0 ? { excludeTypes } : undefined
        );

        if (!mounted) return;

        const users = Array.isArray(response) ? response : [];
        setRecommendations(users);

        if (users.length > 0) {
          try {
            useUsersStore.getState().upsertMany(users);
          } catch (e) {
            logger.warn("Failed to cache users");
          }
        }
      } catch (err) {
        if (!mounted) return;
        const errorMessage = err instanceof Error ? err.message : "Failed to fetch recommendations";
        setError(errorMessage);
        logger.error("Error fetching recommendations");
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchRecommendations();

    return () => {
      mounted = false;
    };
  }, [oxyServices, isAuthenticated]);

  const handleShowMore = useCallback(() => {
    router.push("/explore");
  }, [router]);

  const displayedUsers = useMemo(
    () => recommendations.slice(0, MAX_DISPLAY_USERS),
    [recommendations]
  );

  if (!isAuthenticated) {
    return null;
  }

  if (loading) {
    return (
      <BaseWidget title={t("Who to follow")}>
        <View className="gap-2.5 py-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton.Row key={i} style={{ alignItems: 'center', gap: 10 }}>
              <Skeleton.Circle size={36} />
              <Skeleton.Col>
                <Skeleton.Text style={{ fontSize: 14, lineHeight: 16, width: 120 }} />
                <Skeleton.Text style={{ fontSize: 13, lineHeight: 15, width: 90 }} />
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
      <BaseWidget title={t("Who to follow")}>
        <View className="py-2 items-center gap-2">
          <ThemedText className="text-destructive text-[13px]">
            {error}
          </ThemedText>
        </View>
      </BaseWidget>
    );
  }

  if (displayedUsers.length === 0) {
    return (
      <BaseWidget title={t("Who to follow")}>
        <View className="py-2 items-center">
          <ThemedText className="text-muted-foreground">
            {t("No recommendations available")}
          </ThemedText>
        </View>
      </BaseWidget>
    );
  }

  return (
    <BaseWidget title={t("Who to follow")}>
      <View>
        {displayedUsers.map((user) => (
          <FollowRowComponent key={user.id} profileData={user} />
        ))}
        <TouchableOpacity
          className="py-2"
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

const FollowRowComponent = React.memo(({ profileData }: { profileData: ProfileData }) => {
  const router = useRouter();
  const { oxyServices } = useAuth();
  const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{
    userId: string;
    size?: "small" | "medium" | "large"
  }>;

  const displayName = useMemo(() => {
    if (profileData.name?.full) return profileData.name.full;
    if (profileData.name?.first) {
      return `${profileData.name.first} ${profileData.name.last || ""}`.trim();
    }
    return profileData.username || "Unknown User";
  }, [profileData.name, profileData.username]);

  const avatarUri = profileData.avatar;
  const username = profileData.username || profileData.id;

  const handlePress = useCallback(() => {
    if (profileData.isFederated && profileData.instance) {
      router.push(`/@${profileData.username}@${profileData.instance}`);
    } else {
      router.push(`/@${username}`);
    }
  }, [router, username, profileData.isFederated, profileData.instance, profileData.username]);

  return (
    <View
      className="flex-row justify-between items-center border-border py-2"
      style={[styles.webCursor, styles.itemBorder]}
    >
      <TouchableOpacity className="flex-row items-center flex-1" onPress={handlePress} activeOpacity={0.7}>
        <Avatar source={avatarUri} size={36} />
        <View className="ml-2.5 flex-1 mr-2">
          <UserName
            name={displayName}
            isFederated={profileData.isFederated}
            isAgent={profileData.isAgent}
            isAutomated={profileData.isAutomated}
            variant="small"
            style={{ name: { fontSize: 14 } }}
          />
          <ThemedText className="text-muted-foreground text-[13px] pt-px">
            @{username}
          </ThemedText>
          {profileData.bio && (
            <ThemedText
              className="text-muted-foreground text-[12px] pt-1 leading-4"
              numberOfLines={2}
            >
              {profileData.bio}
            </ThemedText>
          )}
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
