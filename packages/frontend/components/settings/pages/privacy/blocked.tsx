import { ListSkeleton, SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { queryClient } from '@/lib/queryClient';
import { refreshPrivacyLists } from '@/services/privacyService';
import { searchService } from '@/services/searchService';
import { setPrivacyListMembership } from '@/hooks/usePrivacyControls';
import { RiAddCircleLine } from '@oxy.so/bloom/icons/RiAddCircleLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { Button } from '@oxy.so/bloom/button';
import {
  confirm as confirmSettingsAction,
  alert as showSettingsAlert,
} from '@oxy.so/bloom/surfaces';
import type { User } from '@oxy.so/core';
import { createLogger } from '@oxy.so/core/logger';
import { queryKeys } from '@oxy.so/services/ui/client';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button as LButton,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  HStack,
  Icon,
  Loading,
  RawText,
  Search as LSearch,
  SettingsSection as LSettingsSection,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const blockedLogger = createLogger('BlockedUsers');

interface BlockedUser {
  id?: string;
  _id?: string;
  name?: User['name'];
  username?: string;
  handle?: string;
  // Populated from the SDK `User`/`SearchUserResult` (avatar is `string | null`).
  avatar?: string | null;
}

const getUserId = (user: BlockedUser): string | undefined => user.id || user._id;

export default function BlockedUsersScreen() {
  const { t } = useTranslation();

  const {
    user: currentUser,
    oxyServices,
    isAuthResolved,
    canUsePrivateApi,
    isPrivateApiPending,
  } = useAuth();

  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<BlockedUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [blocking, setBlocking] = useState<string | null>(null);

  const loadBlockedUsers = useCallback(async () => {
    if (!oxyServices) {
      blockedLogger.warn('oxyServices not available');
      setBlockedUsers([]);
      setBlockedUserIds([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      blockedLogger.debug('Loading blocked users...');
      const blockedUsersList = await oxyServices.privacy.blocked();
      blockedLogger.debug('Oxy response received', {
        count: blockedUsersList?.length,
      });
      const userIds = (blockedUsersList as unknown as Record<string, unknown>[])
        .map((user) => {
          const blockedId = user.blockedId as string | { _id?: string } | undefined;
          if (blockedId) {
            return typeof blockedId === 'string' ? blockedId : blockedId._id;
          }
          return (user.id || user._id || user.userId) as string | undefined;
        })
        .filter((id): id is string => Boolean(id));
      blockedLogger.debug('Blocked user IDs resolved', {
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
      const fetched = await oxyServices.users.getMany(userIds);
      for (const user of fetched) {
        if (user?.id) {
          queryClient.setQueryData(queryKeys.users.detail(user.id), user);
        }
      }
      // Preserve the blocked order; drop ids the bulk fetch couldn't resolve.
      const byId = new Map(fetched.map((user) => [user.id, user]));
      const users = userIds.map((id) => byId.get(id)).filter((user): user is User => Boolean(user));
      blockedLogger.debug(`Loaded users: ${users.length}`);
      setBlockedUsers(users);
    } catch (error) {
      const err = error as { response?: { data?: unknown } };
      blockedLogger.error('Error loading blocked users', error, {
        responseData: err.response?.data,
      });
      void showSettingsAlert(t('common.error'), t('settings.privacy.failedToLoadBlockedUsers'));
    } finally {
      setLoading(false);
    }
  }, [t, oxyServices]);

  React.useEffect(() => {
    if (canUsePrivateApi) void loadBlockedUsers();
  }, [canUsePrivateApi, loadBlockedUsers]);

  const searchUsersViaOxy = useCallback(
    async (query: string): Promise<BlockedUser[]> => {
      if (oxyServices) {
        try {
          const { data } = await oxyServices.users.search(query, {
            limit: 20,
          });
          return Array.isArray(data) ? data : [];
        } catch (error) {
          blockedLogger.warn('oxyServices.users.search failed, falling back', { error });
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
          return userId && !blockedUserIds.includes(userId) && userId !== currentUser?.id;
        });
        setSearchResults(filtered);
      } catch (error) {
        blockedLogger.error('Error searching users', error);
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
      void showSettingsAlert(t('common.error'), t('settings.privacy.cannotBlockYourself'));
      return;
    }

    try {
      setBlocking(userId);

      setBlockedUserIds((prev) => [...prev, userId]);
      setBlockedUsers((prev) => [...prev, user]);

      setSearchResults((prev) => prev.filter((u) => getUserId(u) !== userId));

      await oxyServices.privacy.block(userId);
      blockedLogger.info('User blocked successfully');

      // Drop Mention's cached copy of this viewer's blocked list so the
      // feed acts on the block now rather than when the freshness window
      // expires. Best-effort: the write to Oxy has already landed.
      await refreshPrivacyLists();

      // The feeds filter on the viewer's held block list; record it now
      // rather than when that list goes stale.
      setPrivacyListMembership(currentUser?.id, 'blocked', userId, true);

      await loadBlockedUsers();

      setSearchQuery('');
      void showSettingsAlert(t('common.success'), t('settings.privacy.userBlocked'));
    } catch (error) {
      const err = error as { response?: { data?: { error?: string } } };
      blockedLogger.error('Error blocking user', error);
      setBlockedUserIds((prev) => prev.filter((id) => id !== userId));
      setBlockedUsers((prev) => prev.filter((u) => getUserId(u) !== userId));
      const errorMessage = err.response?.data?.error || t('settings.privacy.failedToBlockUser');
      void showSettingsAlert(t('common.error'), errorMessage);
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

        await oxyServices.privacy.unblock(userId);
        blockedLogger.info('User unblocked successfully');

        await refreshPrivacyLists();

        setPrivacyListMembership(currentUser?.id, 'blocked', userId, false);

        await loadBlockedUsers();

        void showSettingsAlert(t('common.success'), t('settings.privacy.userUnblocked'));
      } catch (error) {
        const err = error as { response?: { data?: { error?: string } } };
        blockedLogger.error('Error unblocking user', error, {
          responseData: err.response?.data,
        });
        if (userToRemove) {
          setBlockedUserIds((prev) => [...prev, userId]);
          setBlockedUsers((prev) => [...prev, userToRemove]);
        }
        const errorMessage = err.response?.data?.error || t('settings.privacy.failedToUnblockUser');
        void showSettingsAlert(t('common.error'), errorMessage);
      }
    };

    void confirmSettingsAction({
      title: t('settings.privacy.unblockUser'),
      description: t('settings.privacy.unblockUserConfirm'),
      confirmLabel: t('settings.privacy.unblock'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) void performUnblock();
    });
  };

  if (!isAuthResolved || isPrivateApiPending) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.privacy.blocked.signInRequired', {
              defaultValue: 'Sign in to manage blocked accounts',
            })}
            description={t('settings.privacy.blocked.signInRequiredDesc', {
              defaultValue: 'You can block or unblock people once signed in.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  return toElement(
    VStack(
      VStack(
        LSettingsSection(
          t('settings.privacy.searchUsersToBlock'),
          LGroupedSection(
            HStack(
              Icon(RiSearchLine).size('md').foreground('muted'),
              LSearch([searchQuery, handleSearch])
                .autocapitalize('none')
                .autocorrect(false)
                .placeholder(t('settings.privacy.searchUsersToBlock'))
                .label(t('settings.privacy.searchUsersToBlock'))
                .onClearText(() => handleSearch('')),
              Embed(searching && <ListSkeleton count={2} />),
            )
              .padding('horizontal', 'lg')
              .padding('vertical', 'md')
              .align('center')
              .spacing('md'),
          ),
        ),
        searchQuery.length > 0 && searchResults.length > 0
          ? LSettingsSection(
              undefined,
              LGroupedSection(
                Embed(
                  searchResults.map((user) => {
                    const userId = getUserId(user);
                    const handle = user.username || user.handle || '';
                    const isBlocking = blocking === userId;
                    if (!userId || !user.name?.displayName) return null;

                    return toElement(
                      LGroupedSectionItem(user.name.displayName)
                        .wrapControl()
                        .description(`@${handle}`)
                        .trailing(
                          Embed(
                            <Button
                              size="sm"
                              appearance="subtle"
                              tone="neutral"
                              onPress={() => !isBlocking && handleBlock(user)}
                              disabled={isBlocking}
                              accessibilityLabel={user.name.displayName}
                            >
                              {toElement(
                                isBlocking
                                  ? Loading().style('inline').size('sm')
                                  : Icon(RiAddCircleLine).size('22').foreground('primary'),
                              )}
                            </Button>,
                          ),
                        ),
                      userId,
                    );
                  }),
                ),
              ),
            )
          : null,
        searchQuery.length > 0 && !searching && searchResults.length === 0
          ? VStack(
              RawText(t('settings.privacy.noUsersFound'))
                .font('14')
                .leading('20px')
                .foreground('muted'),
            )
              .padding('vertical', 'lg')
              .align('center')
          : null,
        LSettingsSection(
          t('settings.privacy.blockedUsers'),
          LGroupedSection(
            Embed(
              loading ? (
                <ListSkeleton />
              ) : blockedUsers.length === 0 ? (
                toElement(
                  VStack(
                    Embed(
                      <EmptyState
                        title={t('settings.privacy.noBlockedUsers')}
                        sticker="blockedAccounts"
                      />,
                    ),
                  ).padding('vertical', 'lg'),
                )
              ) : (
                blockedUsers.map((user) => {
                  const userId = getUserId(user);
                  const handle = user.username || user.handle || '';
                  if (!userId || !user.name?.displayName) return null;

                  return toElement(
                    LGroupedSectionItem(user.name.displayName)
                      .wrapControl()
                      .description(`@${handle}`)
                      .trailing(
                        LButton(LText(t('settings.privacy.unblock')))
                          .size('sm')
                          .style('subtle')
                          .tint('danger')
                          .onPress(() => {
                            if (userId) {
                              handleUnblock(userId);
                            } else {
                              blockedLogger.error('No userId found for user');
                              void showSettingsAlert(t('common.error'), 'Invalid user ID');
                            }
                          }),
                      ),
                    userId,
                  );
                })
              ),
            ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
