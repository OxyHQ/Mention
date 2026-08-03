import React, { useMemo, useCallback, useState, useEffect } from 'react';
import { Text, TouchableOpacity, View, Share } from 'react-native';
import { Redirect, router, type Href } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { FollowButton as OxyFollowButton, useAuth, useFollow } from '@oxyhq/services/ui/client';
import { usePostsStore } from '@/stores/postsStore';
import { lanesService } from '@/services/lanesService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { openExternalLink } from '@/utils/openExternalLink';
import type { FeedType } from '@mention/shared-types';
import { logger } from '@oxyhq/core/logger';
import type { ProfileData } from '@/hooks/useProfileData';

// Icons
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { Icon } from '@/lib/icons';
import { ShareIcon } from '@/assets/icons/share-icon';
import { MailIcon } from '@/assets/icons/mail-icon';
import { MoreIcon } from '@/assets/icons/more-icon';
import { ExternalLinkIcon } from '@/assets/icons/external-link-icon';

// Components
import UserName from './UserName';
import AnimatedTabBar from './common/AnimatedTabBar';
import { IconButton } from '@/components/ui/Button';
import { SEO } from '@/components/SEO';
import { FediverseSharingBadge } from '@/components/AccountBadge';
import { showFediverseInfo } from '@/components/Fediverse/FediverseInfoDialog';

// Profile components
import {
    ProfileContent,
    ProfileHeader,
    ProfileShell,
    PrivateBadge,
    useSubscription,
    useProfileAccount,
    useProfileChrome,
    useProfileMoreMenu,
    useJustFollowed,
    buildProfileTabDescriptors,
    laneTabKey,
    profileTabIndex,
    profileTabsForAccountKind,
    type LaneTabInput,
    type ProfileScreenProps,
    type ProfileTab,
} from './Profile';
import { SuggestedUsers } from './suggestions/SuggestedUsers';

// Helper functions
const isProfilePrivate = (
    profileData: ProfileData | null,
    privacySettings?: ProfileData['privacy']
): boolean => {
    if (!profileData) return false;
    const privacy = profileData.privacy || privacySettings;
    return Boolean(
        privacy?.profileVisibility === 'private' ||
        privacy?.profileVisibility === 'followers_only'
    );
};

// Feed types for clearing cache
const FEED_TYPES: FeedType[] = ['posts', 'replies', 'media', 'likes', 'boosts'];

interface PersonProfileProps extends ProfileScreenProps {
    username: string;
    handle: string;
    isFederated: boolean;
    profileData: ProfileData | null;
    loading: boolean;
}

/**
 * ONE PERSON's profile page, at `/@<handle>`.
 *
 * Person-shaped throughout, and deliberately so: it has a banner, a poke, the
 * full tab strip, a self view with edit/analytics/settings, and sub-routes under
 * its own URL family. A CHANNEL satisfies none of that and has its own screen
 * (`ChannelScreen`); the two share the chrome, the body, the account lookup and
 * the canonicalization, and nothing else.
 */
const PersonProfile: React.FC<PersonProfileProps> = ({
    tab = 'posts',
    laneId,
    username,
    handle,
    isFederated,
    profileData,
    loading,
}) => {
    const { user: currentUser } = useAuth();
    const { t } = useTranslation();

    // Active tab — local state so tab switching doesn't trigger router
    // navigation. Held as the tab's KEY, not its index: the strip's length
    // depends on how many lanes the publisher has, so an index means a different
    // tab before and after that list loads. A lane deep link therefore paints
    // `posts` for one frame and settles on the lane once its key resolves.
    const [activeTabKey, setActiveTabKey] = useState<string>(
        () => (laneId ? laneTabKey(laneId) : tab),
    );

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
                },
                laneTabs,
                profileData?.kind,
            ),
        [t, laneTabs, profileData?.kind],
    );

    const activeTab = profileTabIndex(tabDescriptors, activeTabKey);
    const activeDescriptor = tabDescriptors[activeTab];
    const activeProfileTab: ProfileTab = activeDescriptor?.tab ?? 'posts';
    const activeLaneId = activeDescriptor?.laneId;

    // Follow data — federated users are stored in Oxy, so useFollow works with their Oxy ID
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

    const isOwnProfile = useMemo(() => {
        if (isFederated) return false;
        if (!currentUser?.id || !profileData?.id) return false;
        return currentUser.id === profileData.id;
    }, [currentUser?.id, profileData?.id, isFederated]);

    const isPrivate = useMemo(
        () => isProfilePrivate(profileData, profileData?.privacy),
        [profileData],
    );

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

    const onTabPress = useCallback(
        (index: number) => {
            if (!username) return;
            const descriptor = tabDescriptors[index];
            if (!descriptor) return;
            setActiveTabKey(descriptor.key);
            // Update the URL silently for deep-linking / sharing without
            // triggering navigation. A lane tab routes by id under its own
            // segment, so it can never collide with a static tab's file name.
            const path: Href = descriptor.laneId
                ? `/@${handle}/lane/${descriptor.laneId}`
                : descriptor.tab === 'posts'
                    ? `/@${handle}`
                    : `/@${handle}/${descriptor.tab}`;
            router.replace(path);
        },
        [username, handle, tabDescriptors],
    );

    // The stats row jumps to a tab BY NAME. Resolving the index at press time is
    // the whole reason `REPLIES_TAB_INDEX = 1` / `BOOSTS_TAB_INDEX = 5` are gone:
    // one lane on the profile shifts every tab after `posts`, and a stale
    // constant sends the reader somewhere else without failing anything.
    const scrollOrSwitch = useCallback(
        (key: string) => {
            const index = profileTabIndex(tabDescriptors, key);
            if (index === activeTab) {
                chrome.scrollToContent(chrome.contentHeight);
            } else {
                onTabPress(index);
            }
        },
        [activeTab, chrome, onTabPress, tabDescriptors],
    );

    const handlePostsPress = useCallback(() => scrollOrSwitch('posts'), [scrollOrSwitch]);
    const handleBoostsPress = useCallback(() => scrollOrSwitch('boosts'), [scrollOrSwitch]);
    const handleRepliesPress = useCallback(() => scrollOrSwitch('replies'), [scrollOrSwitch]);

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

    const handleMoreOptions = useProfileMoreMenu({ profileData, isOwnProfile });

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
                <View className="bg-secondary px-2 py-0.5 rounded-full">
                    <Text className="text-secondary-foreground text-xs font-medium" numberOfLines={1}>
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
                        // The profile is the ONE surface that opts the marker in:
                        // a reader here has room for the answer, and the identity
                        // line is not itself a link to somewhere else.
                        onExplainNetwork={showFediverseInfo}
                        copyableHandle
                        variant="default"
                        style={userNameStyle}
                        trailingBadge={fediverseBadge}
                        handleTrailing={followsYouTag}
                    />
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
                {!isOwnProfile && (
                    <SuggestedUsers visible={justFollowed} sourceUserId={profileData.id} />
                )}
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

    // The tab bar, and — on the viewer's OWN profile only — the way in to their
    // lanes. It belongs beside these tabs because a lane's whole effect is on
    // which of them a post lands on, and because the composer's lane icon was
    // otherwise the only door to the screen that manages them. The row carries
    // the hairline so it stays continuous under the button, which sits outside
    // the tab bar's own bordered box.
    const tabBar = useMemo(
        () => (
            <View className="flex-row items-center border-b border-border bg-background">
                <View className="flex-1" style={{ minWidth: 0 }}>
                    <AnimatedTabBar
                        tabs={tabDescriptors.map((descriptor) => ({
                            id: descriptor.key,
                            label: descriptor.label,
                        }))}
                        activeTabId={activeDescriptor?.key ?? 'posts'}
                        onTabPress={(id) => onTabPress(profileTabIndex(tabDescriptors, id))}
                        scrollEnabled
                        instanceId={username || 'default'}
                    />
                </View>
                {isOwnProfile ? (
                    <TouchableOpacity
                        onPress={() => router.push('/lanes')}
                        activeOpacity={0.7}
                        accessibilityRole="link"
                        accessibilityLabel={t('lanes.title', { defaultValue: 'Lanes' })}
                        className="px-3 py-2.5"
                    >
                        <Icon name="git-branch-outline" size={20} className="text-muted-foreground" />
                    </TouchableOpacity>
                ) : null}
            </View>
        ),
        [activeDescriptor?.key, onTabPress, tabDescriptors, username, isOwnProfile, t],
    );

    const headerActions = (
        <>
            {/* The bell is a toggle rendered as two different glyphs, so its
                label has to carry the state a sighted user reads from the icon —
                a static "Notifications" would leave a screen reader unable to
                tell subscribed from not. */}
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

    return (
        <>
            {profileData ? (
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
            ) : null}
            <ProfileShell
                chrome={chrome}
                loading={loading}
                profileData={profileData}
                banner={{ uri: bannerUri }}
                headerActions={headerActions}
                summary={summary}
                tabBar={tabBar}
                tabs={{
                    tab: activeProfileTab,
                    laneId: activeLaneId,
                    profileId: profileData?.id,
                    isPrivate,
                    isOwnProfile,
                    isFederated,
                    actorUri: profileData?.actorUri,
                }}
            />
        </>
    );
};

const ProfileScreen: React.FC<ProfileScreenProps> = ({ tab = 'posts', laneId }) => {
    const { username, handle, isFederated, profileData, loading, colorName, canonicalHref } =
        useProfileAccount('person');

    // A channel account's page is `/c/<handle>`. Sitting on `/@<handle>` for one
    // is a URL nobody should keep — a post row links every author to `/@`, since
    // the DTO says nothing about account kind, so this is how a reader reaches a
    // channel at all. The rule itself lives in `profileRoute.ts`, shared with the
    // channel screen so the two can never disagree about which way to send.
    if (canonicalHref) {
        return <Redirect href={canonicalHref} />;
    }

    return (
        <BloomColorScope colorPreset={colorName} asChild>
            {/* `web:z-auto` so this profile wrapper does not become its own
                stacking context and trap the sticky header chrome below the
                panel's bleed-mask/border overlays (see ProfileShell's root for
                the full rationale). No effect on native. */}
            <View className="flex-1 bg-background web:z-auto">
                <PersonProfile
                    tab={tab}
                    laneId={laneId}
                    username={username}
                    handle={handle}
                    isFederated={isFederated}
                    profileData={profileData}
                    loading={loading}
                />
            </View>
        </BloomColorScope>
    );
};

export default ProfileScreen;
