import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { useAuth } from "@oxyhq/services";
import * as OxyServicesNS from "@oxyhq/services";
import { Avatar } from '@oxyhq/bloom/avatar';
import { ThemedText } from "@/components/ThemedText";
import { BaseWidget } from "./BaseWidget";
import { useUsersStore } from "@/stores/usersStore";
import { logger } from '@/lib/logger';

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
    // Don't fetch recommendations if user is not authenticated
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    let mounted = true;

    const fetchRecommendations = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await oxyServices.getProfileRecommendations();

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

  // Hide widget when user is not authenticated
  if (!isAuthenticated) {
    return null;
  }

  if (loading) {
    return (
      <BaseWidget title={t("Who to follow")}>
        <View style={styles.centerContainer}>
          <Loading size="small" style={{ flex: undefined }} />
          <ThemedText className="text-muted-foreground" style={styles.statusText}>
            {t("Loading...")}
          </ThemedText>
        </View>
      </BaseWidget>
    );
  }

  if (error) {
    return (
      <BaseWidget title={t("Who to follow")}>
        <View style={styles.centerContainer}>
          <ThemedText className="text-destructive" style={styles.statusText}>
            {error}
          </ThemedText>
        </View>
      </BaseWidget>
    );
  }

  if (displayedUsers.length === 0) {
    return (
      <BaseWidget title={t("Who to follow")}>
        <View style={styles.centerContainer}>
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
        <TouchableOpacity onPress={handleShowMore} style={styles.showMoreBtn} activeOpacity={0.7}>
          <ThemedText className="text-primary" style={styles.showMoreText}>
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
    router.push(`/@${username}`);
  }, [router, username]);

  return (
    <View className="border-border" style={styles.row}>
      <TouchableOpacity style={styles.rowLeft} onPress={handlePress} activeOpacity={0.7}>
        <Avatar source={avatarUri} size={40} />
        <View style={styles.rowTextWrap}>
          <ThemedText className="text-foreground" style={styles.rowTitle}>
            {displayName}
          </ThemedText>
          <ThemedText className="text-muted-foreground" style={styles.rowSub}>
            @{username}
          </ThemedText>
          {profileData.bio && (
            <ThemedText
              className="text-muted-foreground"
              style={styles.rowBio}
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
  centerContainer: {
    paddingVertical: 12,
    alignItems: "center",
    gap: 8,
  },
  statusText: {
    fontSize: 14,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 0.5,
    paddingVertical: 10,
    ...Platform.select({ web: { cursor: "pointer" } }),
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  rowTextWrap: {
    marginLeft: 12,
    flex: 1,
    marginRight: 8,
  },
  rowTitle: {
    fontWeight: "600",
    fontSize: 15,
  },
  rowSub: {
    paddingTop: 2,
    fontSize: 14,
  },
  rowBio: {
    paddingTop: 4,
    fontSize: 13,
    lineHeight: 18,
  },
  showMoreBtn: {
    paddingTop: 10,
  },
  showMoreText: {
    fontSize: 15,
    fontWeight: "500",
  },
});
