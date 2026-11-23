import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import type React from 'react';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { View, RefreshControl, Platform, TouchableOpacity, type ViewStyle } from 'react-native';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiEditBoxLine } from '@oxy.so/bloom/icons/RiEditBoxLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';
import { RiUserAddFill } from '@oxy.so/bloom/icons/RiUserAddFill';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@oxy.so/bloom/button';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Avatar } from '@oxy.so/bloom/avatar';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { ProfileCard, ProfileCardSkeletonList } from '@/components/ProfileCard';

import Feed from '@/components/Feed/Feed';
import { listsService } from '@/services/listsService';
import { subscribeToListChanges } from '@/services/listMutations';
import { useColorTokens, useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { EntityFollowButton } from '@/components/EntityFollowButton';
import { getNormalizedUserHandle, type User } from '@oxy.so/core';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { formatCompactNumber } from '@/utils/formatNumber';
import { shareLink } from '@/utils/shareLink';
import { EmptyState } from '@/components/common/EmptyState';
import { SignInRequired } from '@/components/common/SignInRequired';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  ScrollView,
  TabItem,
  Tabs as LTabs,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';
import {
  Embed as LEmbed,
  VStack as LVStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { hexfff: '#fff' } });

interface ListOwner {
  _id?: string;
  username?: string;
  displayName?: string;
  // Populated from `MentionListOwner` (avatar is `string | null`).
  avatar?: string | null;
}

interface ListData {
  _id?: string;
  id?: string;
  title?: string;
  description?: string;
  avatar?: string;
  isPublic?: boolean;
  owner?: ListOwner;
  createdBy?: ListOwner;
  creator?: ListOwner;
  ownerOxyUserId?: string;
  memberOxyUserIds?: string[];
  subscriberCount?: number;
}

// The title's 26px line over its 22pt size (a leading is a ratio of the size).
const listTokens = defineTokens({ leading: { title: 26 / 22 } });

// Tailwind's `ml-auto`: the language has no auto margin, so this slot stays a view.
const followSlot: ViewStyle = { marginLeft: 'auto' };

// Kept as React Native's TouchableOpacity (the language has no node for its fading
// press); its style draws what its classes drew.
const addPeopleRow: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 12,
  paddingHorizontal: 16,
  paddingVertical: 12,
  borderBottomWidth: 1,
};

const TABS_CONFIG = [
  { id: 'posts', labelKey: 'lists.tabs.posts' },
  { id: 'members', labelKey: 'lists.tabs.members' },
];

function ListDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const theme = useTheme();
  const { t } = useTranslation();

  const [list, setList] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('posts');

  // Stable across renders so the posts-tab Feed's `listHeaderComponent`
  // (which embeds this tab bar) keeps a stable element identity and the
  // memoized Feed does not re-render every parent render.
  const TABS = useMemo(
    () => TABS_CONFIG.map((tab) => ({ id: tab.id, label: t(tab.labelKey) })),
    [t],
  );

  const loadList = useCallback(async () => {
    if (!id) return;
    try {
      const data = await listsService.get(String(id));
      setList(data);
      setError(null);
    } catch {
      setError('Failed to load list');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Auto-refresh when this list's membership/metadata changes anywhere in the
  // app (e.g. from a profile/post "Add to list" action). Re-fetching the list
  // produces fresh `memberOxyUserIds`, which changes the `<Feed authors>` filter
  // so the embedded feed re-fetches automatically — no manual refresh needed.
  useEffect(() => {
    return subscribeToListChanges((changedId) => {
      if (!id) return;
      if (changedId === null || String(changedId) === String(id)) {
        loadList();
      }
    });
  }, [id, loadList]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadList();
  }, [loadList]);

  const listOwner = list?.owner || list?.createdBy || list?.creator;
  const isOwnList = Boolean(user?.id && list?.ownerOxyUserId === user.id);
  // One handle for the byline's link and its hover preview.
  const listOwnerHandle = getNormalizedUserHandle({ username: listOwner?.username }) ?? undefined;
  const memberCount = (list?.memberOxyUserIds || []).length;
  const subscriberCount = list?.subscriberCount ?? 0;
  const listId = String(list?._id || list?.id || id);

  const handleShare = useCallback(async () => {
    const url = `${Platform.OS === 'web' ? window.location.origin : 'https://mention.earth'}/lists/${listId}`;
    await shareLink({
      title: list?.title || 'Check out this list',
      url,
      copiedToast: t('widgetMenu.linkCopied'),
      errorToast: t('widgetMenu.shareFailed'),
    });
  }, [listId, list?.title, t]);

  const bylineText = useMemo(() => {
    if (isOwnList) return t('lists.byYou', { defaultValue: 'List by you' });
    if (listOwner?.displayName) return `List by ${listOwner.displayName}`;
    if (listOwner?.username) return `List by @${listOwner.username}`;
    return 'List';
  }, [isOwnList, listOwner, t]);

  // Subheader (avatar + title + byline + stats + follow) and the tab bar are the
  // list page's scroll-away chrome. On the `posts` tab they are handed to the
  // scroll-owning <Feed> as its `listHeaderComponent` so the single virtualized
  // list owns the document scroll on web (mirrors `feeds/[id].tsx` and native's
  // `ListHeaderComponent`); on the `members` tab the same chrome renders inside
  // that tab's own <ScreenScrollView>. Declared after the data so it can read `list`.
  const renderSubheader = useCallback(
    () =>
      toElement(
        VStack(
          HStack(
            Embed(
              <Avatar
                source={list?.avatar || undefined}
                size={58}
                variant={MEDIA_VARIANT_AVATAR_LG}
                style={{ borderRadius: 12 }}
              />,
            ),
            VStack(
              RawText(list?.title || 'Untitled List')
                .foreground('foreground')
                .font('2xl')
                .weight('bold')
                .leading(listTokens.leading.title)
                .lines(4),
              Embed(
                <ProfileHoverCard username={isOwnList ? undefined : listOwnerHandle}>
                  {toElement(
                    VStack(
                      RawText(bylineText)
                        .foreground('muted')
                        .font('14')
                        .leading('20px')
                        .margin('top', '2xs'),
                    )
                      .onPress(() => {
                        if (listOwnerHandle && !isOwnList) {
                          router.push(`/@${listOwnerHandle}`);
                        }
                      })
                      .disabled(isOwnList || !listOwner?.username),
                  )}
                </ProfileHoverCard>,
              ),
            )
              .flex('1')
              .justify('center'),
          )
            .align('start')
            .spacing('md'),
          /* Description */ list?.description
            ? RawText(list.description)
                .foreground('foreground')
                .font('md')
                .leading('20px')
                .margin('top', 'md')
            : null,
          /* Stats row */ HStack(
            HStack(
              RawText(formatCompactNumber(memberCount))
                .foreground('foreground')
                .font('14')
                .leading('20px')
                .weight('semibold'),
              RawText(memberCount === 1 ? 'member' : 'members')
                .foreground('muted')
                .font('14')
                .leading('20px'),
            )
              .align('center')
              .spacing('xs'),
            HStack(
              RawText(formatCompactNumber(subscriberCount))
                .foreground('foreground')
                .font('14')
                .leading('20px')
                .weight('semibold'),
              RawText(
                subscriberCount === 1
                  ? t('lists.subscriberSingular', { defaultValue: 'subscriber' })
                  : t('lists.subscriberPlural', { defaultValue: 'subscribers' }),
              )
                .foreground('muted')
                .font('14')
                .leading('20px'),
            )
              .align('center')
              .spacing('xs'),
            HStack(
              list?.isPublic
                ? Icon(RiGlobalLine).size('14').foreground('muted')
                : Icon(RiLockLine).size('14').foreground('muted'),
              RawText(list?.isPublic ? 'Public' : 'Private')
                .foreground('muted')
                .font('14')
                .leading('20px'),
            )
              .align('center')
              .spacing('xs'),
            Embed(
              !isOwnList ? (
                <View style={followSlot}>
                  <EntityFollowButton
                    entityType="list"
                    entityId={listId}
                    label={t('lists.followList', { defaultValue: 'Follow list' })}
                    followingLabel={t('lists.followingList', { defaultValue: 'Following' })}
                    size="sm"
                  />
                </View>
              ) : null,
            ),
          )
            .align('center')
            .spacing('lg')
            .margin('top', 'md')
            .margin('bottom', 'xs'),
        )
          .padding('horizontal', 'lg')
          .padding('top', 'md')
          .padding('bottom', 'sm'),
      ),
    [
      list?.avatar,
      list?.title,
      list?.description,
      list?.isPublic,
      listOwner?.username,
      listOwnerHandle,
      isOwnList,
      bylineText,
      memberCount,
      subscriberCount,
      listId,
      theme.colors.textSecondary,
      t,
      router,
    ],
  );

  // Chrome (subheader + tab bar) handed to the posts-tab Feed as its
  // listHeaderComponent. A single element so the Feed treats it as one header.
  const postsTabHeader = useMemo(
    () =>
      toElement(
        VStack(
          Embed(renderSubheader()),
          LTabs(
            ['posts', setActiveTab],
            TABS.map((tab: { id: string; label: string; count?: number }) =>
              TabItem(tab.id, tab.label).count(tab.count),
            ),
          ).style('underline'),
        ),
      ),
    [renderSubheader, TABS, listId],
  );

  const headerActions = (
    <>
      <Button
        appearance="subtle"
        tone="neutral"
        iconOnly
        leadingIcon={Platform.OS === 'web' ? RiLinkM : RiShare2Line}
        onPress={handleShare}
        accessibilityLabel={
          Platform.OS === 'web'
            ? t('postActions.copyLink', { defaultValue: 'Copy link' })
            : t('videos.share', { defaultValue: 'Share' })
        }
      />
      {isOwnList
        ? toElement(
            LButton(Icon(RiEditBoxLine))
              .shape('circle')
              .style('subtle')
              .tint('neutral')
              .onPress(() => router.push(`/lists/${listId}/edit`))
              .label(t('common.edit', { defaultValue: 'Edit' })),
          )
        : null}
    </>
  );

  // Loading state
  if (loading) {
    return (
      <Screen
        header={toElement(
          Header()
            .backLabel(t('common.back', { defaultValue: 'Back' }))
            .inPage(),
        )}
      >
        {toElement(ScrollView(Embed(<DetailSkeleton />)))}
      </Screen>
    );
  }

  // Error state
  if (error || !list) {
    return (
      <Screen
        header={toElement(
          Header(t('lists.detail.title'))
            .backLabel(t('common.back', { defaultValue: 'Back' }))
            .inPage(),
        )}
      >
        {toElement(
          ScrollView(
            Icon(RiAlertLine).size('3xl').foreground('muted'),
            RawText(error || 'List not found')
              .foreground('muted')
              .font('16')
              .leading('normal'),
            Embed(
              LtoElement(
                LVStack(
                  LEmbed(
                    toElement(
                      RawText('Try again')
                        .foreground('primary')
                        .font('14')
                        .leading('20px')
                        .weight('medium'),
                    ),
                  ),
                )
                  .onPress(loadList)
                  .pressFade(),
              ),
            ),
          ).contentView((v) => v.flex('1').align('center').justify('center').spacing('md')),
        )}
      </Screen>
    );
  }

  return (
    <Screen
      header={toElement(
        Header(list.title || t('lists.detail.title'))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .toolbar(Embed(headerActions))
          .inPage(),
      )}
    >
      {/* Tab content.
          `posts` is the ONLY feed tab and it is the scroll-owning virtualized
          <Feed> (no `scrollEnabled={false}`): on web it owns the document scroll
          via the window virtualizer, with the subheader + tab bar handed to it as
          its `listHeaderComponent` (so they scroll away with the content and the
          shell mask/rails/insets still apply); on native the Feed owns its own
          scroll + pull-to-refresh. The `members` tab renders NON-feed content
          inside its own <ScreenScrollView>, so no feed is embedded in a nested scroller
          anywhere here. Mirrors `feeds/[id].tsx`. */}
      {activeTab === 'posts' ? (
        memberCount === 0 ? (
          <ScreenScrollView
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.primary}
              />
            }
          >
            {renderSubheader()}
            {toElement(
              LTabs(
                [activeTab, setActiveTab],
                TABS.map((tab: { id: string; label: string; count?: number }) =>
                  TabItem(tab.id, tab.label).count(tab.count),
                ),
              ).style('underline'),
            )}
            <EmptyState
              title={t('lists.emptyPosts', { defaultValue: 'No posts yet' })}
              subtitle={t('lists.emptyPostsSubtext', {
                defaultValue: 'Add people to this list to see their posts here',
              })}
              sticker="listPosts"
              containerStyle={{ minHeight: 200 }}
            />
          </ScreenScrollView>
        ) : (
          <Feed
            type="mixed"
            filters={{ authors: (list.memberOxyUserIds || []).join(',') }}
            hideHeader
            listHeaderComponent={postsTabHeader}
          />
        )
      ) : (
        <ListMembers
          listId={listId}
          memberIds={list.memberOxyUserIds || []}
          isOwnList={isOwnList}
          refreshing={refreshing}
          onRefresh={onRefresh}
          header={toElement(
            VStack(
              Embed(renderSubheader()),
              LTabs(
                [activeTab, setActiveTab],
                TABS.map((tab: { id: string; label: string; count?: number }) =>
                  TabItem(tab.id, tab.label).count(tab.count),
                ),
              ).style('underline'),
            ),
          )}
        />
      )}
    </Screen>
  );
}

/** Member profiles stay fresh for 5 minutes — membership changes invalidate the list itself. */
const MEMBERS_STALE_TIME_MS = 5 * 60_000;

/** Upper bound on placeholder rows while member profiles resolve. */
const MAX_MEMBER_SKELETON_ROWS = 8;

/**
 * Members tab: shows list members as the shared user row.
 * For list owners, shows an "Add people" button.
 */
function ListMembers({
  listId,
  memberIds,
  isOwnList,
  refreshing,
  onRefresh,
  header,
}: {
  listId: string;
  memberIds: string[];
  isOwnList: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  header?: React.ReactNode;
}) {
  const router = useRouter();
  const theme = useTheme();
  const colors = useColorTokens();
  const { t } = useTranslation();
  const { oxyServices, user } = useAuth();

  // The list document carries only member ids — Oxy owns the identities, so the
  // profiles are resolved in ONE bulk call and rendered through the shared row.
  const { data: members = [], isPending } = useQuery<User[]>({
    queryKey: viewerQueryKeys.listMembers(user?.id, listId, memberIds),
    queryFn: () => oxyServices.users.getMany(memberIds),
    enabled: memberIds.length > 0,
    staleTime: MEMBERS_STALE_TIME_MS,
  });

  // The membership size is known before the profiles are: paint exactly that many
  // placeholder rows (capped) so the tab reserves its real height from the start.
  const resolvingMembers = isPending && memberIds.length > 0;
  const skeletonRowCount = Math.min(memberIds.length, MAX_MEMBER_SKELETON_ROWS);

  return (
    <ScreenScrollView
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      {header}
      {isOwnList && (
        <TouchableOpacity
          style={[addPeopleRow, { borderColor: colors.border }]}
          onPress={() => router.push(`/lists/${listId}/edit`)}
          activeOpacity={0.7}
        >
          {toElement(
            VStack(Icon(RiUserAddFill).size('md').foreground(appColors.color.hexfff))
              .frame({ width: '4xl', height: '4xl' })
              .background('primary')
              .corner('infinite')
              .align('center')
              .justify('center'),
          )}
          {toElement(
            RawText(t('lists.addPeople', { defaultValue: 'Add people' }))
              .foreground('primary')
              .font('md')
              .weight('semibold'),
          )}
        </TouchableOpacity>
      )}
      {memberIds.length === 0 ? (
        <EmptyState
          title={t('lists.emptyMembers', { defaultValue: 'No members yet' })}
          subtitle={
            isOwnList
              ? t('lists.emptyMembersSubtext', {
                  defaultValue: 'Add people to curate this list',
                })
              : undefined
          }
          sticker="listMembers"
          containerStyle={{ minHeight: 200 }}
        />
      ) : (
        toElement(
          VStack(
            RawText(memberIds.length, ' ', memberIds.length === 1 ? 'member' : 'members')
              .padding('horizontal', 'lg')
              .foreground('muted')
              .font('14')
              .leading('20px')
              .margin('bottom', 'sm'),
            Embed(
              resolvingMembers && (
                <ProfileCardSkeletonList count={skeletonRowCount} showFollowButton />
              ),
            ),
            Embed(
              members.map((member) => (
                <ProfileCard
                  key={member.id}
                  profile={{
                    id: member.id,
                    username: member.username,
                    name: member.name,
                    avatar: member.avatar,
                    color: member.color,
                    // `verified` reaches the SDK `User` through its index signature
                    // (typed `unknown`), so it is narrowed rather than cast.
                    verified: typeof member.verified === 'boolean' ? member.verified : undefined,
                    isFederated: member.isFederated,
                    kind: member.kind,
                    instance: member.instance,
                  }}
                  showFollowButton
                />
              )),
            ),
          ).padding('top', 'sm'),
        )
      )}
    </ScreenScrollView>
  );
}

export default function AvailableListDetailScreen() {
  return (
    <SupervisedFeatureGate>
      <ListDetailAccess />
    </SupervisedFeatureGate>
  );
}

function ListDetailAccess() {
  const { canUsePrivateApi } = useAuth();
  const { t } = useTranslation();

  if (!canUsePrivateApi) {
    return (
      <Screen
        scroll="auto"
        header={toElement(
          Header(t('lists.detail.title'))
            .backLabel(t('common.back', { defaultValue: 'Back' }))
            .inPage(),
        )}
      >
        <SignInRequired
          label={t('lists.signInRequired', { defaultValue: 'Sign in to use lists' })}
          description={t('lists.signInRequiredDesc', {
            defaultValue: 'Sign in to view and manage lists.',
          })}
        />
      </Screen>
    );
  }

  return <ListDetailScreen />;
}
