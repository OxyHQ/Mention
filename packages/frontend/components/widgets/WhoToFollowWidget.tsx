import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { useAuth, FollowButton } from "@oxyhq/services";
import { Avatar } from '@oxyhq/bloom/avatar';
import { ThemedText } from "@/components/ThemedText";
import { BaseWidget } from "./BaseWidget";
import { useUserById } from "@/hooks/useCachedUser";
import { queryClient } from "@/lib/queryClient";
import { precacheProfileViews } from "@/lib/precacheProfiles";
import { enrichMissingAvatars } from "@/utils/userEnrichment";
import { getUserPlaceholderColor } from "@/utils/userPlaceholderColor";
import UserName from '@/components/UserName';
import { logger } from '@/lib/logger';
import { getRecommendationFilters } from '@/lib/recommendationFilters';
import { isAuthError } from '@/utils/authErrors';
import { getNormalizedUserHandle } from '@oxyhq/core';

interface ProfileData {
  id: string;
  username?: string;
  name: {
    displayName: string;
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
  const { oxyServices, user } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<ProfileData[]>([]);

  useEffect(() => {
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
          precacheProfileViews(queryClient, users);

          // Fire-and-forget: avatars fill in reactively via useUserById
          void enrichMissingAvatars(
            users.slice(0, MAX_DISPLAY_USERS),
            (id) => oxyServices.getUserById(id),
            queryClient,
          );
        }
      } catch (err) {
        if (!mounted) return;
        // Auth errors should never surface here now that recommendations are
        // public, but if one slips through, degrade to the empty state rather
        // than showing a scary error to logged-out visitors.
        if (isAuthError(err)) {
          logger.warn("WhoToFollowWidget: auth error fetching recommendations, showing empty state");
          setRecommendations([]);
        } else {
          const errorMessage = err instanceof Error ? err.message : "Failed to fetch recommendations";
          setError(errorMessage);
          logger.error("Error fetching recommendations");
        }
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
    // Re-run when the auth identity resolves: `oxyServices` is a stable
    // singleton, so on cold boot this otherwise fires once while anonymous and
    // never refetches the (personalized) recommendations after the session
    // restores. `user?.id` flips from undefined → the real id on resolve.
  }, [oxyServices, user?.id]);

  const handleShowMore = useCallback(() => {
    router.push("/explore");
  }, [router]);

  const displayedUsers = useMemo(
    () => recommendations.slice(0, MAX_DISPLAY_USERS),
    [recommendations]
  );

  if (loading) {
    return (
      <BaseWidget title={t("Who to follow")}>
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
        <Avatar source={profileData.avatar || cachedUser?.avatar} size={34} placeholderColor={getUserPlaceholderColor(cachedUser)} />
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
