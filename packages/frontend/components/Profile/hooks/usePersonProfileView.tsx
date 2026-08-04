import React, { useCallback, useEffect, useMemo } from 'react';
import { Share, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FollowButton as OxyFollowButton, useAuth, useFollow } from '@oxyhq/services/ui/client';
import { logger } from '@oxyhq/core/logger';
import type { FeedType } from '@mention/shared-types';

import { usePostsStore } from '@/stores/postsStore';
import { lanesService } from '@/services/lanesService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { openExternalLink } from '@/utils/openExternalLink';
import { IconButton } from '@/components/ui/Button';
import { SEO } from '@/components/SEO';
import { FediverseSharingBadge } from '@/components/AccountBadge';
import { showFediverseInfo } from '@/components/Fediverse/FediverseInfoDialog';
import { SuggestedUsers } from '@/components/suggestions/SuggestedUsers';
import UserName from '@/components/UserName';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { MailIcon } from '@/assets/icons/mail-icon';
import { MoreIcon } from '@/assets/icons/more-icon';
import { ExternalLinkIcon } from '@/assets/icons/external-link-icon';

import { AccountCategoryLine } from '../AccountCategoryLine';
import { PrivateBadge } from '../PrivateBadge';
import { ProfileContent } from '../ProfileContent';
import { ProfileHeader } from '../ProfileHeader';
import {
  buildProfileTabDescriptors,
  profileTabIndex,
  profileTabsForAccountKind,
  type LaneTabInput,
  type ProfileTabDescriptor,
  type ProfileTabsProps,
} from '../types';
import { isProfilePrivate, viewerOwnsProfile } from '../profileViewer';
import { profileTabHref } from '../profileTabRoute';
import { useProfileAccount } from './useProfileAccount';
import { useProfileChrome, type ProfileChrome } from './useProfileChrome';
import { useProfileMoreMenu } from './useProfileMoreMenu';
import { useOperatesAccount } from './useOperatesAccount';
import { useJustFollowed } from './useJustFollowed';
import { useSubscription } from './useSubscription';
import type { ProfileAccount } from './useProfileAccount';

/** Feed types cleared from the local store when a profile turns out to be private. */
const FEED_TYPES: FeedType[] = ['posts', 'replies', 'media', 'likes', 'boosts'];

export interface PersonProfileViewOptions {
  /**
   * The descriptor key currently selected — `posts`, `replies`, `lane:<id>`, …
   *
   * Passed IN rather than held here, because the two platforms answer it from
   * different places: on web the route does (the strip lives in the layout and
   * every tab is its own URL), on native the screen's own state does. Deriving
   * it here would mean picking one of those and breaking the other.
   */
  activeKey: string;
  /**
   * Go to another tab. Called only when the target differs from
   * {@link PersonProfileViewOptions.activeKey} — re-selecting the active tab
   * scrolls to the top of its content instead, which is handled here so both
   * platforms behave the same way.
   *
   * The `href` is supplied rather than rebuilt by the caller: the handle it is
   * built from is resolved HERE, and a caller that had to wait for it could not
   * define this callback without a circular dependency on its own result.
   */
  onSelectTab: (descriptor: ProfileTabDescriptor, href: Href) => void;
}

export interface PersonProfileView extends ProfileAccount {
  isOwnProfile: boolean;
  isPrivate: boolean;
  /** The banner band's image, if the account has set one. */
  bannerUri?: string;
  /** The strip's contents, lanes spliced in after `posts`. */
  tabDescriptors: ProfileTabDescriptor[];
  /** The selected tab, or the first one while a lane key is still resolving. */
  activeDescriptor: ProfileTabDescriptor | undefined;
  chrome: ProfileChrome;
  headerActions: React.ReactNode;
  summary: React.ReactElement | null;
  seo: React.ReactElement | null;
  tabs: ProfileTabsProps;
  /** Select a tab by descriptor key: navigates, or scrolls if already there. */
  selectTab: (key: string) => void;
}

/**
 * Everything ONE PERSON's profile page is, apart from where its pieces are
 * rendered.
 *
 * It exists because those pieces stopped being rendered in one place. On web the
 * chrome — banner, identity summary, action cluster, tab strip — belongs to the
 * `(tabs)` LAYOUT so that switching tabs cannot unmount it, while the tab's
 * content is a routed screen; on native the whole page is still one screen (see
 * `ProfileTabsChrome.tsx` for why the two differ). Both need the same account
 * lookup, the same lane query, the same strip, the same summary and the same
 * scroll chrome, and every value here is tuned against the others — a second
 * copy would be correct for exactly as long as nobody touched either.
 *
 * This serves more than people: only a `channel` routes to `/c/<handle>`, so an
 * ORGANIZATION, PROJECT or BOT renders through here at `/@<handle>` too.
 */
export function usePersonProfileView({
  activeKey,
  onSelectTab,
}: PersonProfileViewOptions): PersonProfileView {
  const account = useProfileAccount('person');
  const { username, handle, isFederated, profileData } = account;
  const { user: currentUser } = useAuth();
  const { t } = useTranslation();

  // The publisher's lanes that HAVE a tab. Public and reader-agnostic, so a
  // signed-out visitor sees the same strip; keyed by viewer anyway, like every
  // other private read, so an account switch drops it with the namespace.
  const { data: laneTabs = [] } = useQuery<LaneTabInput[]>({
    queryKey: viewerQueryKeys.lanesForOwner(currentUser?.id, profileData?.id),
    enabled: Boolean(profileData?.id) && !isFederated,
    queryFn: async () => {
      const lanes = await lanesService.listForOwner(profileData?.id ?? '');
      return lanes.map((lane) => ({ id: lane.id, name: lane.name }));
    },
  });

  // Every person — federated included — gets the full static strip, since the
  // data behind each tab is in Oxy/Mention's DB either way. Lane tabs are
  // spliced in after `posts`.
  const tabDescriptors = useMemo(
    () =>
      buildProfileTabDescriptors(
        {
          posts: t('profile.tabs.posts'),
          replies: t('profile.tabs.replies'),
          media: t('profile.tabs.media'),
          videos: t('profile.tabs.videos'),
          likes: t('profile.tabs.likes'),
          boosts: t('profile.tabs.boosts'),
          feeds: t('profile.tabs.feeds', { defaultValue: 'Feeds' }),
          starter_packs: t('profile.tabs.starter_packs', { defaultValue: 'Starter Packs' }),
          lists: t('profile.tabs.lists', { defaultValue: 'Lists' }),
          // A person has no writers tab — `profileTabsForAccountKind` drops it
          // for every kind but `channel`. The label is still passed because
          // `labels` covers every `ProfileTab` by contract: the caller has no
          // reason to know which subset survives, and an unused label costs one
          // `t()`.
          writers: t('profile.tabs.writers', { defaultValue: 'Writers' }),
        },
        laneTabs,
        profileData?.kind,
      ),
    [t, laneTabs, profileData?.kind],
  );

  const activeIndex = profileTabIndex(tabDescriptors, activeKey);
  const activeDescriptor = tabDescriptors[activeIndex];
  const activeProfileTab = activeDescriptor?.tab ?? 'posts';
  const activeLaneId = activeDescriptor?.laneId;

  // Follow data — federated users are stored in Oxy, so useFollow works with
  // their Oxy ID.
  const stableUserId = profileData?.id || '';
  const {
    followerCount: rawFollowerCount,
    followingCount: rawFollowingCount,
    isFollowing: isFollowingProfileUser = false,
  } = useFollow(stableUserId);
  const followerCount = rawFollowerCount ?? 0;
  const followingCount = rawFollowingCount ?? 0;

  // Show suggestions only on the follow ACTION, never on a revisit.
  const justFollowed = useJustFollowed(stableUserId, isFollowingProfileUser);

  const { subscribed, loading: subLoading, toggle: toggleSubscription } = useSubscription(
    profileData?.id,
    currentUser?.id,
    currentUser?.id === profileData?.id,
  );

  const design = profileData?.design;
  const avatarUri = design?.avatar;
  // A stored banner is shown whenever there is one. Whether the banner BAND
  // exists at all is not in question here — a person's layout has one, and an
  // account with no image set gets the tinted placeholder.
  const bannerUri = design?.bannerUrl;

  const isOwnProfile = viewerOwnsProfile(profileData, currentUser?.id, isFederated);
  const isPrivate = useMemo(() => isProfilePrivate(profileData), [profileData]);

  // Number of action icons in the top-right cluster; sizes the scrolled name
  // overlay so a long display name truncates instead of sliding under them.
  const headerActionCount = useMemo(() => {
    let count = 1; // share is always present
    if (!isOwnProfile) count += 2; // subscribe + more
    // DM is local-only — remote (federated) actors have no Mention inbox.
    if (!isOwnProfile && !isFederated) count += 1;
    if (isFederated) count += 1; // open-on-instance
    return count;
  }, [isOwnProfile, isFederated]);

  const chrome = useProfileChrome({
    profileId: profileData?.id,
    currentTab: activeProfileTab,
    currentLaneId: activeLaneId,
    headerActionCount,
    hasBannerBand: true,
  });

  // Clear cached feed data for private profiles
  useEffect(() => {
    if (isPrivate && !isOwnProfile && profileData?.id) {
      const { clearUserFeed } = usePostsStore.getState();
      FEED_TYPES.forEach((type) => {
        clearUserFeed(profileData.id, type);
      });
    }
  }, [isPrivate, isOwnProfile, profileData?.id]);

  // The stats row jumps to a tab BY NAME. Resolving the index at press time is
  // the whole reason `REPLIES_TAB_INDEX = 1` / `BOOSTS_TAB_INDEX = 5` are gone:
  // one lane on the profile shifts every tab after `posts`, and a stale constant
  // sends the reader somewhere else without failing anything.
  const selectTab = useCallback(
    (key: string) => {
      const index = profileTabIndex(tabDescriptors, key);
      const descriptor = tabDescriptors[index];
      if (!descriptor) return;
      if (descriptor.key === activeDescriptor?.key) {
        chrome.scrollToContent(chrome.contentHeight);
        return;
      }
      onSelectTab(descriptor, profileTabHref(handle, descriptor));
    },
    [activeDescriptor?.key, chrome, handle, onSelectTab, tabDescriptors],
  );

  const handlePostsPress = useCallback(() => selectTab('posts'), [selectTab]);
  const handleBoostsPress = useCallback(() => selectTab('boosts'), [selectTab]);
  const handleRepliesPress = useCallback(() => selectTab('replies'), [selectTab]);

  const handleShare = useCallback(async () => {
    if (!profileData) return;
    try {
      const shareUrl = `https://mention.earth/@${handle}`;
      const shareMessage = t('profile.share.message', {
        name: profileData.design.displayName,
        defaultValue: `Check out ${profileData.design.displayName}'s profile on Mention!`,
      });
      await Share.share({
        message: `${shareMessage}\n\n${shareUrl}`,
        url: shareUrl,
        title: t('profile.share.title', {
          name: profileData.design.displayName,
          defaultValue: `${profileData.design.displayName} on Mention`,
        }),
      });
    } catch {
      logger.error('Error sharing profile');
    }
  }, [profileData, handle, t]);

  /**
   * `isOwnProfile` still governs everything else on this screen, and correctly:
   * edit-profile, analytics, settings and the lanes button all act on the
   * VIEWER'S OWN account, so operating an organization must not put them within
   * reach. Only the hostile menu asks the wider question.
   */
  const operatesThisAccount = useOperatesAccount({
    accountId: profileData?.id,
    accountKind: profileData?.kind,
  });

  const handleMoreOptions = useProfileMoreMenu({
    profileData,
    viewerOperatesAccount: isOwnProfile || operatesThisAccount,
  });

  const handleDM = useCallback(() => {
    if (!profileData?.id) return;
    const params = new URLSearchParams({
      userId: profileData.id,
      username: profileData.username,
    });
    router.push(`/ai?${params.toString()}`);
  }, [profileData?.id, profileData?.username]);

  // Open on remote instance (federated only)
  const handleOpenOnInstance = useCallback(() => {
    if (profileData?.actorUri) openExternalLink(profileData.actorUri);
  }, [profileData?.actorUri]);

  const userNameStyle = useMemo(
    () => ({
      name: { fontSize: 24, fontWeight: 'bold' as const, marginTop: 10, marginBottom: 4 },
      handle: { fontSize: 15, marginBottom: 12 },
      container: undefined,
    }),
    [],
  );

  const identity = useMemo(() => {
    if (!profileData) return null;
    // Own, non-federated profile opted into fediverse sharing (absent flag ⇒
    // on): a tappable badge next to the handle explaining the fediverse.
    // The PROFILE is where the explainer is opted into — the marker is inert
    // on every other surface (see `AccountBadge`).
    const fediverseBadge =
      isOwnProfile && !profileData.isFederated && currentUser?.fediverseSharing !== false ? (
        <FediverseSharingBadge size={20} onExplainNetwork={showFediverseInfo} />
      ) : undefined;
    // Passive "Follows you" tag inline to the right of the @handle when this
    // profile follows the viewer. Never shown on the viewer's own profile.
    const followsYouTag =
      !isOwnProfile && currentUser?.id && profileData.followsYou ? (
        <View className="bg-muted px-2 py-0.5 rounded-full">
          <Text className="text-muted-foreground text-xs font-medium" numberOfLines={1}>
            {t('profile.followsYou', { defaultValue: 'Follows you' })}
          </Text>
        </View>
      ) : undefined;
    return (
      <>
        <ProfileHeader
          username={profileData.username}
          avatarUri={avatarUri}
          isOwnProfile={isOwnProfile}
          isFederated={profileData.isFederated}
          actorUri={profileData.actorUri}
          isFollowing={profileData.isFollowing}
          currentUsername={currentUser?.username}
          profileId={profileData.id}
          FollowButtonComponent={OxyFollowButton}
        />
        <View>
          <UserName
            name={profileData.design.displayName}
            handle={profileData.username}
            verified={profileData.verified}
            isFederated={profileData.isFederated}
            kind={profileData.kind}
            // The profile is the ONE surface that opts the marker in: a reader
            // here has room for the answer, and the identity line is not itself
            // a link to somewhere else.
            onExplainNetwork={showFediverseInfo}
            copyableHandle
            variant="default"
            style={userNameStyle}
            trailingBadge={fediverseBadge}
            handleTrailing={followsYouTag}
          />
          {/* Non-personal accounts route here too — an organization, a project
              or a bot is a `person`-FAMILY url (only `channel` gets `/c/`), and
              all four kinds carry categories. A personal account never has any,
              so this renders nothing for the overwhelming majority of
              profiles. */}
          <AccountCategoryLine accountCategories={profileData.accountCategories} align="start" />
          {isPrivate && (
            <View className="flex-row items-center gap-2 flex-wrap">
              <PrivateBadge privacySettings={profileData.privacy} />
            </View>
          )}
        </View>
      </>
    );
  }, [profileData, isOwnProfile, isPrivate, avatarUri, currentUser, userNameStyle, t]);

  const summary = useMemo(() => {
    if (!profileData) return null;
    return (
      <View>
        <ProfileContent
          profileData={profileData}
          isOwnProfile={isOwnProfile}
          isPrivate={isPrivate}
          followingCount={followingCount}
          followerCount={followerCount}
          profileHandle={handle}
          identity={identity}
          showReplies={profileTabsForAccountKind(profileData.kind).includes('replies')}
          aboutHref={`/@${handle}/about`}
          followingHref={`/@${handle}/following`}
          followersHref={`/@${handle}/followers`}
          onPostsPress={handlePostsPress}
          onBoostsPress={handleBoostsPress}
          onRepliesPress={handleRepliesPress}
          onLayout={chrome.setContentHeight}
        />
        {!isOwnProfile && <SuggestedUsers visible={justFollowed} sourceUserId={profileData.id} />}
      </View>
    );
  }, [
    chrome.setContentHeight,
    followerCount,
    followingCount,
    handle,
    handleBoostsPress,
    handlePostsPress,
    handleRepliesPress,
    identity,
    isOwnProfile,
    isPrivate,
    justFollowed,
    profileData,
  ]);

  const headerActions = (
    <>
      {/* The bell is a toggle rendered as two different glyphs, so its label has
          to carry the state a sighted user reads from the icon — a static
          "Notifications" would leave a screen reader unable to tell subscribed
          from not. */}
      {!isOwnProfile && (
        <IconButton
          variant="icon"
          onPress={toggleSubscription}
          disabled={subLoading}
          accessibilityLabel={
            subscribed
              ? t('profile.actions.unsubscribe', {
                  handle,
                  defaultValue: 'Stop notifying me about new posts from @{{handle}}',
                })
              : t('profile.actions.subscribe', {
                  handle,
                  defaultValue: 'Notify me about new posts from @{{handle}}',
                })
          }
        >
          {subscribed ? (
            <BellActive size={18} className="text-primary" />
          ) : (
            <Bell size={18} className="text-foreground" />
          )}
        </IconButton>
      )}
      {!isOwnProfile && !isFederated && (
        <IconButton
          variant="icon"
          onPress={handleDM}
          accessibilityLabel={t('profile.actions.message', {
            handle,
            defaultValue: 'Message @{{handle}}',
          })}
        >
          <MailIcon size={18} className="text-foreground" />
        </IconButton>
      )}
      {isFederated && (
        <IconButton
          variant="icon"
          onPress={handleOpenOnInstance}
          accessibilityLabel={t('profile.actions.openOnInstance', {
            handle,
            defaultValue: 'Open @{{handle}} on their home instance',
          })}
        >
          <ExternalLinkIcon size={18} className="text-foreground" />
        </IconButton>
      )}
      <IconButton
        variant="icon"
        onPress={handleShare}
        accessibilityLabel={t('profile.actions.share', {
          handle,
          defaultValue: "Share @{{handle}}'s profile",
        })}
      >
        <ShareIcon size={18} className="text-foreground" />
      </IconButton>
      {!isOwnProfile && (
        <IconButton
          variant="icon"
          onPress={handleMoreOptions}
          accessibilityLabel={t('profile.actions.more', {
            handle,
            defaultValue: 'More options for @{{handle}}',
          })}
        >
          <MoreIcon size={18} className="text-foreground" />
        </IconButton>
      )}
    </>
  );

  const seo = profileData ? (
    <SEO
      title={t('seo.profile.title', {
        name: profileData.design.displayName,
        username,
        defaultValue: `${profileData.design.displayName} (@${username}) on Mention`,
      })}
      description={
        profileData.bio
          ? t('seo.profile.description', {
              name: profileData.design.displayName,
              bio: profileData.bio,
              defaultValue: `View ${profileData.design.displayName}'s profile on Mention. ${profileData.bio}`,
            })
          : t('seo.profile.description', {
              name: profileData.design.displayName,
              bio: '',
              defaultValue: `View ${profileData.design.displayName}'s profile on Mention.`,
            })
      }
      image={avatarUri || bannerUri}
      type="profile"
    />
  ) : null;

  return {
    ...account,
    isOwnProfile,
    isPrivate,
    bannerUri,
    tabDescriptors,
    activeDescriptor,
    chrome,
    headerActions,
    summary,
    seo,
    tabs: {
      tab: activeProfileTab,
      laneId: activeLaneId,
      profileId: profileData?.id,
      isPrivate,
      isOwnProfile,
      isFederated,
      actorUri: profileData?.actorUri,
    },
    selectTab,
  };
}
