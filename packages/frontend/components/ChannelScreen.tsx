import React, { useCallback, useMemo, useState } from 'react';
import { View, Share } from 'react-native';
import { Redirect, router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { FollowButton as OxyFollowButton, useAuth, useFollow } from '@oxyhq/services/ui/client';
import { lanesService } from '@/services/lanesService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { logger } from '@oxyhq/core/logger';
import type { ProfileData } from '@/hooks/useProfileData';

// Icons
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { Icon } from '@/lib/icons';
import { ShareIcon } from '@/assets/icons/share-icon';
import { MoreIcon } from '@/assets/icons/more-icon';

// Components
import UserName from './UserName';
import AnimatedTabBar from './common/AnimatedTabBar';
import { IconButton } from '@/components/ui/Button';
import { SEO } from '@/components/SEO';

// Profile primitives
import {
    ChannelActions,
    ChannelHeader,
    ProfileContent,
    ProfileShell,
    useSubscription,
    useProfileAccount,
    useProfileChrome,
    useProfileMoreMenu,
    useOperatesAccount,
    useJustFollowed,
    useChannelWriters,
    buildProfileTabDescriptors,
    profileTabIndex,
    type LaneTabInput,
    type ProfileTab,
} from './Profile';
import { SuggestedUsers } from './suggestions/SuggestedUsers';

interface ChannelProfileProps {
    username: string;
    handle: string;
    profileData: ProfileData | null;
    loading: boolean;
}

/**
 * ONE CHANNEL's page, at `/c/<handle>`.
 *
 * A channel is an Oxy ACCOUNT that people follow WITHOUT following the people
 * who write for it, and its page is that account's author feed. It shares the
 * chrome, the body, the account lookup and the canonicalization with a person's
 * profile — those are the same job — and nothing else, because almost every
 * other affordance on a profile is addressed to a human who can be signed in.
 *
 * What is ABSENT here is absent structurally, not suppressed by a flag:
 *
 * - **No banner.** `UpdateAccountInput` has no banner field, so there is nothing
 *   to set and no band left empty.
 * - **No poke.** A poke is addressed to a person; `isActAsEligibleKind` refuses
 *   `channel`, so no human is ever signed in as one to receive it.
 * - **No self view.** For the same reason, `isOwnProfile` can never be true for
 *   a channel — so no edit/analytics/settings cluster, no "your own lanes"
 *   button beside the tabs, and no fediverse badge (which is own-profile only).
 * - **No DM.** `/ai` messages a person's Mention inbox; a channel has none.
 * - **No "Follows you" tag.** A channel cannot follow anybody, since following
 *   requires a session it can never have.
 * - **Four tabs, not nine.** `profileTabsForAccountKind` drops the five a channel
 *   account can never fill; see its docstring for the three separate reasons.
 * - **No tab in the URL.** `/c/<handle>` is ONE route with no sub-tabs beneath
 *   it, so its tabs are local state — the writers tab included. Writing
 *   `/@<handle>/media` here would navigate a channel out of its own URL family,
 *   and giving ONE channel tab a `/c/<handle>/…` route of its own while the
 *   other four stay local state would be a worse inconsistency than either
 *   answer applied uniformly. `about` and `settings` are separate SCREENS, not
 *   tabs, which is why they have routes.
 *
 * What is ADDED is the operator's way in — a channel has no login, so its
 * settings are reachable only from the overflow menu of whoever operates it —
 * and a FIFTH tab that only a channel can have: `writers`, present when this
 * channel names the people who write for it (see below).
 */
const ChannelProfile: React.FC<ChannelProfileProps> = ({
    username,
    handle,
    profileData,
    loading,
}) => {
    const { user: currentUser } = useAuth();
    const { t } = useTranslation();

    const [activeTabKey, setActiveTabKey] = useState<string>('posts');

    // A lane's owner is an `oxyUserId` and a channel account is one, so a channel
    // has lanes like any other publisher.
    const { data: laneTabs = [] } = useQuery<LaneTabInput[]>({
        queryKey: viewerQueryKeys.lanesForOwner(currentUser?.id, profileData?.id),
        enabled: Boolean(profileData?.id),
        queryFn: async () => {
            const lanes = await lanesService.listForOwner(profileData?.id ?? '');
            return lanes.map((lane) => ({ id: lane.id, name: lane.name }));
        },
    });

    // Whether this channel NAMES the people who write for it, which is the whole
    // rule for the writers tab. It is not on the profile DTO — the disclosure is
    // a Mention-owned setting on the channel account, and the writers endpoint
    // reports it only by REFUSING (one 404 for "not a channel", "does not sign"
    // and "you may not see this channel" alike). So the tab is keyed on the
    // query having succeeded, never on the list being non-empty: a channel that
    // discloses and has published nothing signed keeps its tab and says so.
    //
    // The tab's own content reads this same hook, so the two share one cached
    // answer and opening the tab costs no second request.
    const { disclosed: disclosesWriters } = useChannelWriters(profileData?.id);

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
                    writers: t('profile.tabs.writers', { defaultValue: 'Writers' }),
                },
                laneTabs,
                'channel',
                disclosesWriters,
            ),
        [t, laneTabs, disclosesWriters],
    );

    const activeTab = profileTabIndex(tabDescriptors, activeTabKey);
    const activeDescriptor = tabDescriptors[activeTab];
    const activeProfileTab: ProfileTab = activeDescriptor?.tab ?? 'posts';
    const activeLaneId = activeDescriptor?.laneId;

    const stableUserId = profileData?.id || '';
    const {
        followerCount: rawFollowerCount,
        followingCount: rawFollowingCount,
        isFollowing: isFollowingChannel = false,
    } = useFollow(stableUserId);

    // Following a channel is as good a moment to suggest similar accounts as
    // following a person — the card is about the account just followed, and a
    // channel is one.
    const justFollowed = useJustFollowed(stableUserId, isFollowingChannel);

    const { subscribed, loading: subLoading, toggle: toggleSubscription } = useSubscription(
        profileData?.id,
        currentUser?.id,
        false,
    );

    // Whether the viewer OPERATES this channel — what puts its settings in reach,
    // and what keeps mute / block / report out of a menu where they would be
    // addressed at an account the viewer publishes as. A channel account has no
    // login of its own, so there is no other signal on the profile itself.
    //
    // The check is shared with the person screen rather than local to this one:
    // only `channel` routes to `/c/<handle>`, so an organization, project or bot
    // renders over there and needs the identical answer.
    const operatesThisChannel = useOperatesAccount({
        accountId: profileData?.id,
        accountKind: profileData?.kind,
    });

    // The chrome's compact-header offsets and the scrolled-name overlay both need
    // to know how wide the icon cluster is: subscribe + share + more.
    const chrome = useProfileChrome({
        profileId: profileData?.id,
        currentTab: activeProfileTab,
        currentLaneId: activeLaneId,
        headerActionCount: 3,
        hasBannerBand: false,
    });

    const onTabPress = useCallback(
        (index: number) => {
            const descriptor = tabDescriptors[index];
            if (!descriptor) return;
            setActiveTabKey(descriptor.key);
        },
        [tabDescriptors],
    );

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
    // A channel has no replies tab, so the replies stat is never rendered and
    // this can never fire — `ProfileContent` still requires the handler, so it
    // jumps to `posts` rather than to a tab that is not there.
    const handleRepliesPress = handlePostsPress;

    const handleShare = useCallback(async () => {
        if (!profileData) return;
        try {
            const shareUrl = `https://mention.earth/c/${handle}`;
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
            logger.error('Error sharing channel');
        }
    }, [profileData, handle, t]);

    // Operators only, and first: it is the one action in the menu that is about
    // running this account rather than about the viewer's relationship to it.
    // Everyone else never sees a row that would refuse them.
    const leadingActions = useMemo(
        () =>
            operatesThisChannel
                ? [
                    {
                        icon: <Icon name="settings-outline" size={22} className="text-foreground" />,
                        label: t('channels.settings.title', { defaultValue: 'Channel settings' }),
                        onPress: () => router.push(`/c/${handle}/settings`),
                    },
                ]
                : undefined,
        [operatesThisChannel, handle, t],
    );

    // `viewerOperatesAccount`, never `isOwnProfile: false` as this read before.
    // That literal was true of the LOGIN identity — a channel can never be signed
    // in as, so it is never "your own profile" — and it silently answered a
    // different question from the one the menu asks, which is how an operator came
    // to be offered Block and Report against their own channel.
    const handleMoreOptions = useProfileMoreMenu({
        profileData,
        viewerOperatesAccount: operatesThisChannel,
        leadingActions,
    });

    // A channel is an Oxy account like any other, so its visibility setting is
    // readable even though the channel-settings screen does not offer one today.
    // Read rather than assumed: hardcoding "public" would silently expose a
    // channel somebody had restricted through another surface.
    const isPrivate = Boolean(
        profileData?.privacy?.profileVisibility === 'private' ||
        profileData?.privacy?.profileVisibility === 'followers_only',
    );

    const identity = useMemo(() => {
        if (!profileData) return null;
        return (
            <>
                <ChannelHeader
                    displayName={profileData.design.displayName}
                    username={profileData.username}
                    avatarUri={profileData.design.avatar}
                    verified={profileData.verified}
                    isPrivate={isPrivate}
                    privacySettings={profileData.privacy}
                    UserNameComponent={UserName}
                />
                {/* The last element of the centred masthead, and the boundary
                    the left-aligned body starts after — so it gets an equal
                    gap on both sides rather than the tighter `mb` a control
                    tucked under a left-aligned name row wanted. */}
                <View className="mt-4 mb-4">
                    <ChannelActions
                        profileId={profileData.id}
                        isFollowing={profileData.isFollowing}
                        FollowButtonComponent={OxyFollowButton}
                    />
                </View>
            </>
        );
    }, [profileData, isPrivate]);

    const summary = useMemo(() => {
        if (!profileData) return null;
        return (
            <View>
                <ProfileContent
                    profileData={profileData}
                    isOwnProfile={false}
                    isPrivate={isPrivate}
                    followingCount={rawFollowingCount ?? 0}
                    followerCount={rawFollowerCount ?? 0}
                    profileHandle={handle}
                    identity={identity}
                    showReplies={false}
                    // The channel's OWN about page. `/@<handle>/about` renders
                    // fine for a channel, which is exactly why this was wrong
                    // and silent: it is the person family's route, and an
                    // account should never be sat on a URL it does not own.
                    aboutHref={`/c/${handle}/about`}
                    // STILL the person family, and deliberately so pending a
                    // decision. These two are not a second `about`: both render
                    // `connections.tsx`, whose tab strip navigates with a
                    // hardcoded `/@` and whose four tabs include `who-may-know`
                    // — a list of accounts the VIEWER might know, which is not
                    // about this profile at all and makes no sense hanging off a
                    // channel. Moving them under `/c/` means making that screen
                    // family-aware AND deciding its tab set per account kind, so
                    // it is its own change rather than a line here.
                    followingHref={`/@${handle}/following`}
                    followersHref={`/@${handle}/followers`}
                    onPostsPress={handlePostsPress}
                    onBoostsPress={handleBoostsPress}
                    onRepliesPress={handleRepliesPress}
                    onLayout={chrome.setContentHeight}
                />
                <SuggestedUsers visible={justFollowed} sourceUserId={profileData.id} />
            </View>
        );
    }, [
        chrome.setContentHeight,
        justFollowed,
        handle,
        handleBoostsPress,
        handlePostsPress,
        handleRepliesPress,
        identity,
        isPrivate,
        profileData,
        rawFollowerCount,
        rawFollowingCount,
    ]);

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
            </View>
        ),
        [activeDescriptor?.key, onTabPress, tabDescriptors, username],
    );

    const headerActions = (
        <>
            {/* The bell is a toggle rendered as two different glyphs, so its
                label has to carry the state a sighted user reads from the icon. */}
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
                    description={t('seo.profile.description', {
                        name: profileData.design.displayName,
                        bio: profileData.bio ?? '',
                        defaultValue: `View ${profileData.design.displayName}'s profile on Mention.`,
                    })}
                    image={profileData.design.avatar}
                    type="profile"
                />
            ) : null}
            <ProfileShell
                chrome={chrome}
                loading={loading}
                profileData={profileData}
                banner={null}
                skeletonVariant="channel"
                headerActions={headerActions}
                summary={summary}
                tabBar={tabBar}
                tabs={{
                    tab: activeProfileTab,
                    laneId: activeLaneId,
                    profileId: profileData?.id,
                    isPrivate,
                    isOwnProfile: false,
                    isFederated: false,
                }}
            />
        </>
    );
};

const ChannelScreen: React.FC = () => {
    const { username, handle, profileData, loading, colorName, canonicalHref } =
        useProfileAccount('channel');

    // A `/c/<handle>` that names a person is a URL nobody should keep. The rule
    // itself lives in `profileRoute.ts`, shared with the person screen, so the
    // two can never send a reader back and forth between them.
    if (canonicalHref) {
        return <Redirect href={canonicalHref} />;
    }

    return (
        <BloomColorScope colorPreset={colorName} asChild>
            {/* `web:z-auto` so this wrapper does not become its own stacking
                context and trap the sticky header chrome below the panel's
                bleed-mask/border overlays (see ProfileShell's root). */}
            <View className="flex-1 bg-background web:z-auto">
                <ChannelProfile
                    username={username}
                    handle={handle}
                    profileData={profileData}
                    loading={loading}
                />
            </View>
        </BloomColorScope>
    );
};

export default ChannelScreen;
