import { EmptyState } from "@/components/common/EmptyState";
import { queryClient } from "@/lib/queryClient";
import { refreshPrivacyLists } from "@/services/privacyService";
import { searchService } from "@/services/searchService";
import { usePrivacyStore } from "@/stores/privacyStore";
import { Button } from "@oxy.so/bloom/button";
import { RiAddCircleLine } from '@oxy.so/bloom/icons/RiAddCircleLine';
import { RiInformationFill } from '@oxy.so/bloom/icons/RiInformationFill';
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

const restrictedLogger = createLogger("RestrictedUsers");

interface RestrictedUser {
  id?: string;
  _id?: string;
  name?: User["name"];
  username?: string;
  handle?: string;
  // Populated from the SDK `User`/`SearchUserResult` (avatar is `string | null`).
  avatar?: string | null;
}

const getUserId = (user: RestrictedUser): string | undefined =>
  user.id || user._id;

export default function RestrictedUsersScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const {
    user: currentUser,
    isAuthResolved,
    canUsePrivateApi,
    isPrivateApiPending,
    oxyServices,
  } = useAuth();

  // Authoritative cross-app sync: keep the shared privacy store in lockstep so
  // `usePrivacyControls().isRestricted` (which gates interactions everywhere)
  // reflects a restrict/unrestrict immediately, without waiting for the store's
  // interval refresh or a possibly-cached `getRestrictedUsers` refetch.
  const setStoreRestricted = usePrivacyStore((state) => state.setRestricted);
  const [restrictedUserIds, setRestrictedUserIds] = useState<string[]>([]);
  const [restrictedUsers, setRestrictedUsers] = useState<RestrictedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RestrictedUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [restricting, setRestricting] = useState<string | null>(null);

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortControllerRef = useRef<AbortController | null>(null);
  const restrictedUserIdsSet = useMemo(
    () => new Set(restrictedUserIds),
    [restrictedUserIds],
  );

  const loadRestrictedUsers = useCallback(async () => {
    if (!canUsePrivateApi) {
      restrictedLogger.debug("Not authenticated, skipping load");
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      restrictedLogger.debug("Loading restricted users...");
      const restrictedUsersList = await oxyServices.getRestrictedUsers();
      restrictedLogger.debug("Oxy response", {
        count: restrictedUsersList?.length,
      });
      let userIds = (
        restrictedUsersList as unknown as Record<string, unknown>[]
      )
        .map((user) => {
          const restrictedId = user.restrictedId as
            string | { _id?: string } | undefined;
          if (restrictedId) {
            return typeof restrictedId === "string"
              ? restrictedId
              : restrictedId._id;
          }
          return (user.id || user._id || user.userId) as string | undefined;
        })
        .filter((id): id is string => Boolean(id));

      const currentUserId = currentUser?.id;
      if (currentUserId) {
        userIds = userIds.filter((id: string) => id !== currentUserId);
      }

      restrictedLogger.debug("Restricted user IDs filtered", {
        count: userIds.length,
      });
      setRestrictedUserIds(userIds);

      if (userIds.length === 0) {
        setRestrictedUsers([]);
        setLoading(false);
        return;
      }

      // Single bulk fetch for all restricted profiles (no per-id N+1, no
      // manual batching — the SDK chunks 100/req internally). Results are
      // primed into the shared React Query cache for downstream reads.
      const fetched = await oxyServices.getUsersByIds(userIds);
      for (const user of fetched) {
        if (user?.id) {
          queryClient.setQueryData(queryKeys.users.detail(user.id), user);
        }
      }
      // Preserve order; drop ids the bulk fetch couldn't resolve.
      const byId = new Map(fetched.map((user) => [user.id, user]));
      const users = userIds
        .map((id) => byId.get(id))
        .filter((user): user is User => Boolean(user));
      restrictedLogger.debug(`Loaded ${users.length} users`);
      setRestrictedUsers(users);
    } catch (error) {
      const err = error as { response?: { data?: unknown } };
      restrictedLogger.error("Error loading restricted users", error, {
        responseData: err.response?.data,
      });
      void showSettingsAlert(
        t("common.error"),
        t("settings.privacy.failedToLoadRestrictedUsers"),
      );
    } finally {
      setLoading(false);
    }
  }, [t, currentUser?.id, canUsePrivateApi, oxyServices]);

  useEffect(() => {
    if (canUsePrivateApi) {
      loadRestrictedUsers();
    }
  }, [canUsePrivateApi, loadRestrictedUsers]);

  const performSearch = useCallback(
    async (query: string) => {
      if (searchAbortControllerRef.current) {
        searchAbortControllerRef.current.abort();
      }

      if (!query.trim()) {
        setSearchResults([]);
        setSearching(false);
        return;
      }

      const abortController = new AbortController();
      searchAbortControllerRef.current = abortController;

      try {
        setSearching(true);
        let results: RestrictedUser[] = [];
        if (oxyServices?.searchProfiles) {
          try {
            const { data } = await oxyServices.searchProfiles(query, {
              limit: 20,
            });
            results = Array.isArray(data) ? data : [];
          } catch (oxyError) {
            restrictedLogger.warn(
              "oxyServices.searchProfiles failed, falling back",
              { error: oxyError },
            );
            const fallbackResults = await searchService.searchUsers(query);
            results = fallbackResults.filter((user) => Boolean(user.name));
          }
        } else {
          const fallbackResults = await searchService.searchUsers(query);
          results = fallbackResults.filter((user) => Boolean(user.name));
        }

        if (abortController.signal.aborted) {
          return;
        }

        const filtered = results.filter((user) => {
          const userId = getUserId(user);
          return (
            userId &&
            !restrictedUserIdsSet.has(userId) &&
            userId !== currentUser?.id
          );
        });
        setSearchResults(filtered);
      } catch (error) {
        const err = error as { name?: string };
        if (err.name !== "AbortError") {
          restrictedLogger.error("Error searching users", error);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setSearching(false);
        }
      }
    },
    [restrictedUserIdsSet, currentUser?.id, oxyServices],
  );

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);

      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      if (!query.trim()) {
        setSearchResults([]);
        setSearching(false);
        return;
      }

      searchTimeoutRef.current = setTimeout(() => {
        performSearch(query);
      }, 300);
    },
    [performSearch],
  );

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      if (searchAbortControllerRef.current) {
        searchAbortControllerRef.current.abort();
      }
    };
  }, []);

  const handleRestrict = async (user: RestrictedUser) => {
    const userId = getUserId(user);
    if (!userId) return;

    if (currentUser?.id === userId) {
      void showSettingsAlert(
        t("common.error"),
        t("settings.privacy.cannotRestrictYourself"),
      );
      return;
    }

    try {
      setRestricting(userId);

      setRestrictedUserIds((prev) => [...prev, userId]);
      setRestrictedUsers((prev) => [...prev, user]);

      setSearchResults((prev) => prev.filter((u) => getUserId(u) !== userId));
      await oxyServices.restrictUser(userId);
      restrictedLogger.debug("User restricted successfully");

      // Same as a block: Mention caches the viewer's restricted list per
      // request window, so it has to be told. Best-effort.
      await refreshPrivacyLists();

      setStoreRestricted(userId, true);

      await loadRestrictedUsers();

      setSearchQuery("");
      void showSettingsAlert(
        t("common.success"),
        t("settings.privacy.userRestricted"),
      );
    } catch (error) {
      const err = error as { response?: { data?: { error?: string } } };
      restrictedLogger.error("Error restricting user", error);
      setRestrictedUserIds((prev) => prev.filter((id) => id !== userId));
      setRestrictedUsers((prev) => prev.filter((u) => getUserId(u) !== userId));
      const errorMessage =
        err.response?.data?.error || t("settings.privacy.failedToRestrictUser");
      void showSettingsAlert(t("common.error"), errorMessage);
    } finally {
      setRestricting(null);
    }
  };

  const handleUnrestrict = async (userId: string) => {
    const userToRemove = restrictedUsers.find((u) => getUserId(u) === userId);

    const performUnrestrict = async () => {
      try {
        restrictedLogger.debug(`Unrestricting user: ${userId}`);

        setRestrictedUserIds((prev) => prev.filter((id) => id !== userId));
        setRestrictedUsers((prev) =>
          prev.filter((u) => getUserId(u) !== userId),
        );

        await oxyServices.unrestrictUser(userId);
        restrictedLogger.debug("User unrestricted successfully");

        await refreshPrivacyLists();

        setStoreRestricted(userId, false);

        await loadRestrictedUsers();

        void showSettingsAlert(
          t("common.success"),
          t("settings.privacy.userUnrestricted"),
        );
      } catch (error) {
        const err = error as { response?: { data?: { error?: string } } };
        restrictedLogger.error("Error unrestricting user", error, {
          responseData: err.response?.data,
        });
        if (userToRemove) {
          setRestrictedUserIds((prev) => [...prev, userId]);
          setRestrictedUsers((prev) => [...prev, userToRemove]);
        }
        const errorMessage =
          err.response?.data?.error ||
          t("settings.privacy.failedToUnrestrictUser");
        void showSettingsAlert(t("common.error"), errorMessage);
      }
    };

    void confirmSettingsAction({
      title: t("settings.privacy.unrestrictUser"),
      description: t("settings.privacy.unrestrictUserConfirm"),
      confirmLabel: t("settings.privacy.unrestrict"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) void performUnrestrict();
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
          label={t("settings.privacy.restricted.signInRequired", {
            defaultValue: "Sign in to manage restricted accounts",
          })}
          description={t("settings.privacy.restricted.signInRequiredDesc", {
            defaultValue:
              "Restricted accounts can interact with you but their replies are hidden by default.",
          })}
        />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <SettingsSection>
          <SettingsCard>
            <View className="px-4 py-3.5 flex-row items-center gap-3">
              <RiInformationFill width={20} height={20} fill={colors.primary} />
              <Text className="flex-1 text-[13px] text-foreground">
                {t("settings.privacy.restrictedUsersDescription")}
              </Text>
            </View>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection label={t("settings.privacy.searchUsersToRestrict")}>
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
                placeholder={t("settings.privacy.searchUsersToRestrict")}
                label={t("settings.privacy.searchUsersToRestrict")}
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
                const isRestricting = restricting === userId;
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
                      onPress={() => !isRestricting && handleRestrict(user)}
                      disabled={isRestricting}
                      accessibilityLabel={user.name.displayName}
                    >
                      {isRestricting ? (
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

        <SettingsSection label={t("settings.privacy.restrictedUsers")}>
          <SettingsCard>
            {loading ? (
              <View className="py-10 items-center">
                <Loading
                  className="text-primary"
                  size="large"
                  style={{ flex: undefined }}
                />
              </View>
            ) : restrictedUsers.length === 0 ? (
              <View className="py-4">
                <EmptyState
                  title={t("settings.privacy.noRestrictedUsers")}
                  icon={{
                    name: "people-outline",
                    size: 48,
                  }}
                />
              </View>
            ) : (
              restrictedUsers.map((user) => {
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
                            handleUnrestrict(userId);
                          } else {
                            restrictedLogger.error(
                              "No userId found for user",
                              undefined,
                              { user },
                            );
                            void showSettingsAlert(
                              t("common.error"),
                              "Invalid user ID",
                            );
                          }
                        }}
                      >
                        {t("settings.privacy.unrestrict")}
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
