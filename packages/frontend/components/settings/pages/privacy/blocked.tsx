import { EmptyState } from "@/components/common/EmptyState";
import { queryClient } from "@/lib/queryClient";
import { refreshPrivacyLists } from "@/services/privacyService";
import { searchService } from "@/services/searchService";
import { usePrivacyStore } from "@/stores/privacyStore";
import { Button } from "@oxy.so/bloom/button";
import { RiAddCircleLine } from '@oxy.so/bloom/icons/RiAddCircleLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { Loading } from "@oxy.so/bloom/loading";
import { Search } from "@oxy.so/bloom/search";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import {
  confirm as confirmSettingsAction,
  alert as showSettingsAlert,
} from "@oxy.so/bloom/surfaces";
import { useTheme } from "@oxy.so/bloom/theme";
import type { User } from "@oxy.so/core";
import { createLogger } from "@oxy.so/core/logger";
import { queryKeys } from "@oxy.so/services";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";

import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

const blockedLogger = createLogger("BlockedUsers");

interface BlockedUser {
  id?: string;
  _id?: string;
  name?: User["name"];
  username?: string;
  handle?: string;
  // Populated from the SDK `User`/`SearchUserResult` (avatar is `string | null`).
  avatar?: string | null;
}

const getUserId = (user: BlockedUser): string | undefined =>
  user.id || user._id;

export default function BlockedUsersScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const {
    user: currentUser,
    oxyServices,
    isAuthResolved,
    canUsePrivateApi,
    isPrivateApiPending,
  } = useAuth();

  // Authoritative cross-app sync: keep the shared privacy store in lockstep so
  // `usePrivacyControls().isBlocked` (which gates interactions everywhere)
  // reflects a block/unblock immediately, without waiting for the store's
  // interval refresh or a possibly-cached `getBlockedUsers` refetch.
  const setStoreBlocked = usePrivacyStore((state) => state.setBlocked);
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<BlockedUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [blocking, setBlocking] = useState<string | null>(null);

  const loadBlockedUsers = useCallback(async () => {
    if (!oxyServices?.getBlockedUsers) {
      blockedLogger.warn("oxyServices.getBlockedUsers not available");
      setBlockedUsers([]);
      setBlockedUserIds([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      blockedLogger.debug("Loading blocked users...");
      const blockedUsersList = await oxyServices.getBlockedUsers();
      blockedLogger.debug("Oxy response received", {
        count: blockedUsersList?.length,
      });
      const userIds = (blockedUsersList as unknown as Record<string, unknown>[])
        .map((user) => {
          const blockedId = user.blockedId as
            string | { _id?: string } | undefined;
          if (blockedId) {
            return typeof blockedId === "string" ? blockedId : blockedId._id;
          }
          return (user.id || user._id || user.userId) as string | undefined;
        })
        .filter((id): id is string => Boolean(id));
      blockedLogger.debug("Blocked user IDs resolved", {
        count: userIds.length,
      });
      setBlockedUserIds(userIds);

      if (userIds.length === 0) {
        setBlockedUsers([]);
        setLoading(false);
        return;
      }

      // Single bulk fetch for all blocked profiles (no per-id N+1). The
      // results are primed into the shared React Query cache so any
      // `useUserById`/profile read for these ids hits the cache.
      const fetched = await oxyServices.getUsersByIds(userIds);
      for (const user of fetched) {
        if (user?.id) {
          queryClient.setQueryData(queryKeys.users.detail(user.id), user);
        }
      }
      // Preserve the blocked order; drop ids the bulk fetch couldn't resolve.
      const byId = new Map(fetched.map((user) => [user.id, user]));
      const users = userIds
        .map((id) => byId.get(id))
        .filter((user): user is User => Boolean(user));
      blockedLogger.debug(`Loaded users: ${users.length}`);
      setBlockedUsers(users);
    } catch (error) {
      const err = error as { response?: { data?: unknown } };
      blockedLogger.error("Error loading blocked users", error, {
        responseData: err.response?.data,
      });
      void showSettingsAlert(
        t("common.error"),
        t("settings.privacy.failedToLoadBlockedUsers"),
      );
    } finally {
      setLoading(false);
    }
  }, [t, oxyServices]);

  React.useEffect(() => {
    if (canUsePrivateApi) void loadBlockedUsers();
  }, [canUsePrivateApi, loadBlockedUsers]);

  const searchUsersViaOxy = useCallback(
    async (query: string): Promise<BlockedUser[]> => {
      if (oxyServices?.searchProfiles) {
        try {
          const { data } = await oxyServices.searchProfiles(query, {
            limit: 20,
          });
          return Array.isArray(data) ? data : [];
        } catch (error) {
          blockedLogger.warn(
            "oxyServices.searchProfiles failed, falling back",
            { error },
          );
        }
      }
      const results = await searchService.searchUsers(query);
      return results.filter((user) => Boolean(user.name));
    },
    [oxyServices],
  );

  const handleSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (!query.trim()) {
        setSearchResults([]);
        return;
      }

      try {
        setSearching(true);
        const results = await searchUsersViaOxy(query);
        const filtered = results.filter((user) => {
          const userId = getUserId(user);
          return (
            userId &&
            !blockedUserIds.includes(userId) &&
            userId !== currentUser?.id
          );
        });
        setSearchResults(filtered);
      } catch (error) {
        blockedLogger.error("Error searching users", error);
      } finally {
        setSearching(false);
      }
    },
    [blockedUserIds, currentUser?.id, searchUsersViaOxy],
  );

  const handleBlock = async (user: BlockedUser) => {
    const userId = getUserId(user);
    if (!userId) return;

    if (currentUser?.id === userId) {
      void showSettingsAlert(
        t("common.error"),
        t("settings.privacy.cannotBlockYourself"),
      );
      return;
    }

    try {
      setBlocking(userId);

      setBlockedUserIds((prev) => [...prev, userId]);
      setBlockedUsers((prev) => [...prev, user]);

      setSearchResults((prev) => prev.filter((u) => getUserId(u) !== userId));

      await oxyServices.blockUser(userId);
      blockedLogger.info("User blocked successfully");

      // Drop Mention's cached copy of this viewer's blocked list so the
      // feed acts on the block now rather than when the freshness window
      // expires. Best-effort: the write to Oxy has already landed.
      await refreshPrivacyLists();

      setStoreBlocked(userId, true);

      await loadBlockedUsers();

      setSearchQuery("");
      void showSettingsAlert(
        t("common.success"),
        t("settings.privacy.userBlocked"),
      );
    } catch (error) {
      const err = error as { response?: { data?: { error?: string } } };
      blockedLogger.error("Error blocking user", error);
      setBlockedUserIds((prev) => prev.filter((id) => id !== userId));
      setBlockedUsers((prev) => prev.filter((u) => getUserId(u) !== userId));
      const errorMessage =
        err.response?.data?.error || t("settings.privacy.failedToBlockUser");
      void showSettingsAlert(t("common.error"), errorMessage);
    } finally {
      setBlocking(null);
    }
  };

  const handleUnblock = async (userId: string) => {
    const userToRemove = blockedUsers.find((u) => getUserId(u) === userId);

    const performUnblock = async () => {
      try {
        blockedLogger.debug(`Unblocking user: ${userId}`);

        setBlockedUserIds((prev) => prev.filter((id) => id !== userId));
        setBlockedUsers((prev) => prev.filter((u) => getUserId(u) !== userId));

        await oxyServices.unblockUser(userId);
        blockedLogger.info("User unblocked successfully");

        await refreshPrivacyLists();

        setStoreBlocked(userId, false);

        await loadBlockedUsers();

        void showSettingsAlert(
          t("common.success"),
          t("settings.privacy.userUnblocked"),
        );
      } catch (error) {
        const err = error as { response?: { data?: { error?: string } } };
        blockedLogger.error("Error unblocking user", error, {
          responseData: err.response?.data,
        });
        if (userToRemove) {
          setBlockedUserIds((prev) => [...prev, userId]);
          setBlockedUsers((prev) => [...prev, userToRemove]);
        }
        const errorMessage =
          err.response?.data?.error ||
          t("settings.privacy.failedToUnblockUser");
        void showSettingsAlert(t("common.error"), errorMessage);
      }
    };

    void confirmSettingsAction({
      title: t("settings.privacy.unblockUser"),
      description: t("settings.privacy.unblockUserConfirm"),
      confirmLabel: t("settings.privacy.unblock"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) void performUnblock();
    });
  };

  if (!isAuthResolved || isPrivateApiPending) {
    return (
      <View className="gap-4">
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t("settings.privacy.blocked.signInRequired", {
            defaultValue: "Sign in to manage blocked accounts",
          })}
          description={t("settings.privacy.blocked.signInRequiredDesc", {
            defaultValue: "You can block or unblock people once signed in.",
          })}
        />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <SettingsSection label={t("settings.privacy.searchUsersToBlock")}>
          <SettingsCard>
            <View className="px-4 py-3 flex-row items-center gap-3">
              <RiSearchLine
                width={20}
                height={20}
                fill={colors.textSecondary}
              />
              <Search
                value={searchQuery}
                onValueChange={handleSearch}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t("settings.privacy.searchUsersToBlock")}
                label={t("settings.privacy.searchUsersToBlock")}
                onClearText={() => handleSearch("")}
              />
              {searching && (
                <Loading
                  className="text-primary"
                  size="small"
                  style={{ flex: undefined }}
                />
              )}
            </View>
          </SettingsCard>
        </SettingsSection>

        {searchQuery.length > 0 && searchResults.length > 0 && (
          <SettingsSection>
            <SettingsCard>
              {searchResults.map((user) => {
                const userId = getUserId(user);
                const handle = user.username || user.handle || "";
                const isBlocking = blocking === userId;
                if (!userId || !user.name?.displayName) return null;

                return (
                  <SettingsRow
                    label={user.name.displayName}
                    description={`@${handle}`}
                    key={userId}
                  >
                    <Button
                      size="small"
                      appearance="subtle"
                      tone="neutral"
                      onPress={() => !isBlocking && handleBlock(user)}
                      disabled={isBlocking}
                      accessibilityLabel={user.name.displayName}
                    >
                      {isBlocking ? (
                        <Loading
                          className="text-primary"
                          variant="inline"
                          size="small"
                          style={{ flex: undefined }}
                        />
                      ) : (
                        <RiAddCircleLine
                          width={22}
                          height={22}
                          fill={colors.primary}
                        />
                      )}
                    </Button>
                  </SettingsRow>
                );
              })}
            </SettingsCard>
          </SettingsSection>
        )}

        {searchQuery.length > 0 && !searching && searchResults.length === 0 && (
          <View className="py-4 items-center">
            <Text className="text-sm text-muted-foreground">
              {t("settings.privacy.noUsersFound")}
            </Text>
          </View>
        )}

        <SettingsSection label={t("settings.privacy.blockedUsers")}>
          <SettingsCard>
            {loading ? (
              <View className="py-10 items-center">
                <Loading
                  className="text-primary"
                  size="large"
                  style={{ flex: undefined }}
                />
              </View>
            ) : blockedUsers.length === 0 ? (
              <View className="py-4">
                <EmptyState
                  title={t("settings.privacy.noBlockedUsers")}
                  icon={{
                    name: "people-outline",
                    size: 48,
                  }}
                />
              </View>
            ) : (
              blockedUsers.map((user) => {
                const userId = getUserId(user);
                const handle = user.username || user.handle || "";
                if (!userId || !user.name?.displayName) return null;

                return (
                  <SettingsRow
                    label={user.name.displayName}
                    description={`@${handle}`}
                    key={userId}
                  >
                    {
                      <Button
                        size="small"
                        appearance="subtle"
                        tone="danger"
                        onPress={() => {
                          if (userId) {
                            handleUnblock(userId);
                          } else {
                            blockedLogger.error("No userId found for user");
                            void showSettingsAlert(
                              t("common.error"),
                              "Invalid user ID",
                            );
                          }
                        }}
                      >
                        {t("settings.privacy.unblock")}
                      </Button>
                    }
                  </SettingsRow>
                );
              })
            )}
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
