import { lazy, Suspense } from 'react';
import type { useRouter } from '@/lib/navigation/router';
import type { QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import { createLogger } from '@oxy.so/core/logger';
import type { useTheme } from '@oxy.so/bloom/theme';
import { usePostsStore } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import { confirmDialog } from '@/utils/alerts';
import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { toast } from '@oxy.so/bloom/toast';
import type { BottomSheetContextProps } from '@/context/BottomSheetContext';
import { getNormalizedUserHandle } from '@oxy.so/core';
import type { HydratedPost } from '@mention/shared-types';
import type { FeedItem } from '@/db';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiBarChartBoxLine } from '@oxy.so/bloom/icons/RiBarChartBoxLine';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiFileList2Line } from '@oxy.so/bloom/icons/RiFileList2Line';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { RiLinksLine } from '@oxy.so/bloom/icons/RiLinksLine';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { RiMicOffLine } from '@oxy.so/bloom/icons/RiMicOffLine';
import { RiNodeTree } from '@oxy.so/bloom/icons/RiNodeTree';
import { RiPushpinLine } from '@oxy.so/bloom/icons/RiPushpinLine';
import { RiSpamLine } from '@oxy.so/bloom/icons/RiSpamLine';
import { RiUnpinLine } from '@oxy.so/bloom/icons/RiUnpinLine';
import Ionicons from '@/components/common/Ionicons';
import { muteService } from '@/services/muteService';
import { lanesService } from '@/services/lanesService';
import { noteLaneListsChanged } from '@/stores/laneInvalidation';
import { reportService } from '@/services/reportService';
import { communityService } from '@/services/communityService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { invalidateProfileCounts } from '@/stores/profileCountsInvalidation';
import { postPermalink } from '@/utils/postPermalink';

/**
 * The post overflow menu, built when the reader PRESSES "⋯" — never per row.
 *
 * This used to be `usePostActions`, a hook every mounted `PostItem` called: it
 * resolved theme, auth, i18n, router, safe-back, the bottom sheet, the query
 * client and three store selectors, then built nine action arrays of JSX icons,
 * for every row on screen, though almost no row's menu is ever opened. Now the
 * row holds one stable command (`usePostInteractions().openMenu`) and this runs
 * once per press, against the post as the store holds it at that moment — so a
 * menu can no longer act on a stale captured copy either.
 *
 * The five sheets below are LAZY because the feed chunk imports this module.
 *
 * Every one of them is only ever mounted from an `onPress`, into
 * `bottomSheet.setBottomSheetContent`. Imported statically they were pulled into
 * the feed chunk anyway, together with their service graphs (`insightsService`,
 * `muteService`, `reportService`, `lanesService`, `listsService`) — and
 * `PostItem` was already declaring `lazy(() => import(…))` for
 * `PostInsightsSheet`, so that boundary bought nothing while this file named the
 * same module eagerly.
 *
 * Keep them lazy, and keep each render site wrapped in `<Suspense>`: a static
 * `import` added back here silently defeats the split for the most-used screen
 * in the app, with nothing failing to say so.
 */
const PostInsightsSheet = lazy(() => import('@/components/Post/PostInsightsSheet'));
const ReplySettingsSheet = lazy(() => import('@/components/Compose/ReplySettingsSheet'));
const ReportModal = lazy(() =>
  import('@/components/report/ReportModal').then((m) => ({ default: m.ReportModal })),
);
const AddToListSheet = lazy(() =>
  import('@/components/Lists/AddToListSheet').then((m) => ({ default: m.AddToListSheet })),
);
const LanePickerSheet = lazy(() => import('@/components/Compose/LanePickerSheet'));

const logger = createLogger('postMenuActions');

/** App-lifetime services the menu needs, bound once by `PostInteractionsBinder`. */
export interface PostMenuDeps {
  theme: ReturnType<typeof useTheme>;
  t: TFunction;
  viewerId: string | undefined;
  /**
   * `useAuth().canUsePrivateApi`. Save, lists, mute and report are writes on
   * the viewer's own account, so without a session they can only answer 401 —
   * a signed-out reader is not offered them at all. Reading actions (copy
   * link, the article, sources) stay. Never bare `isAuthenticated`, which is
   * true before the session can make a private call.
   */
  canUsePrivateApi: boolean;
  router: ReturnType<typeof useRouter>;
  /** The app's Back, to leave a post's own page once it is deleted. */
  back: (() => void) | undefined;
  bottomSheet: BottomSheetContextProps;
  queryClient: QueryClient;
}

export interface PostMenuParams {
  viewPost: HydratedPost;
  isOwner: boolean;
  /**
   * True only for the FOCUSED post on `/p/<id>` — the one surface where deleting
   * the post must also leave the screen. Passed in rather than read off the
   * route: the row knows which variant it is rendering.
   */
  isPostDetail: boolean;
  canViewInsights: boolean;
  canStopSharing: boolean;
  isSaved: boolean;
  hasArticle: boolean;
  hasSources: boolean;
  /**
   * The viewer moderates the community hosted here the post is written in —
   * an active member of it, read off the account graph by the binder. The
   * server re-checks every action (`assertCanModerateCommunity`).
   */
  moderatesCommunity: boolean;
  onSave: () => Promise<void>;
  onOpenArticle: () => void;
  onOpenSources: () => void;
}

export interface PostMenuActions {
  insightsAction: ActionMenuAction[];
  saveActionGroup: ActionMenuAction[];
  addToListAction: ActionMenuAction[];
  stopSharingAction: ActionMenuAction[];
  deleteAction: ActionMenuAction[];
  articleAction: ActionMenuAction[];
  sourcesAction: ActionMenuAction[];
  muteReportAction: ActionMenuAction[];
  communityModerationAction: ActionMenuAction[];
  copyLinkAction: ActionMenuAction[];
}

export function buildPostMenuActions(
  {
    viewPost,
    isOwner,
    isPostDetail,
    canViewInsights,
    canStopSharing,
    isSaved,
    hasArticle,
    hasSources,
    moderatesCommunity,
    onSave,
    onOpenArticle,
    onOpenSources,
  }: PostMenuParams,
  { theme, t, viewerId, canUsePrivateApi, router, back, bottomSheet, queryClient }: PostMenuDeps,
): PostMenuActions {
  const { removePostEverywhere, reinsertPost, updatePostEverywhere } = usePostsStore.getState();
  {
    const postId = viewPost?.id;
    const postUrl = postPermalink(postId);
    const isPinned = Boolean(viewPost?.metadata?.isPinned);

    const handleDelete = async () => {
      const confirmed = await confirmDialog({
        title: t('postActions.deletePost'),
        message: t('postActions.deleteConfirmMessage'),
        okText: t('postActions.delete'),
        cancelText: t('postActions.cancel'),
        destructive: true,
      });
      if (!confirmed || !postId) return;

      // Snapshot the post BEFORE removing it so a failed delete can roll the
      // optimistic removal back. Prefer the richer cached copy; fall back to
      // the post passed into the hook (the only copy available on web, where
      // SQLite — and therefore the shared cache read — is unavailable).
      const snapshot: FeedItem = usePostsStore.getState().getPostFromDb(postId) ?? viewPost;
      const authorId = viewPost?.user?.id;

      // Optimistic removal: drop it from every feed (SQLite reactive removal
      // on native; the feed query cache on web) so it vanishes instantly —
      // Twitter/Threads-style — instead of lingering through the round-trip.
      removePostEverywhere(postId);
      if (isPostDetail) back?.();

      try {
        await feedService.deletePost(postId);
        invalidateProfileCounts(queryClient, authorId);
        // The pinned slot lives in React Query (ProfileTabs); refetch it so a
        // deleted pinned post clears from the author's profile too.
        if (authorId) {
          queryClient.invalidateQueries({
            queryKey: viewerQueryKeys.pinnedPost(viewerId, authorId),
          });
        }
      } catch (e) {
        logger.error('Delete API failed — rolling back optimistic removal', e);
        // Roll back: the post still exists server-side, so re-insert it and
        // surface the error instead of leaving the UI inconsistent.
        reinsertPost(snapshot);
        toast(t('postActions.failedToDeletePost'), { type: 'error' });
      }
    };

    const insightsAction = canViewInsights
      ? [
          {
            icon: <RiBarChartBoxLine width={20} height={20} fill={theme.colors.textSecondary} />,
            label: t('postActions.insights'),
            onPress: () => {
              bottomSheet.setBottomSheetContent(
                <Suspense fallback={null}>
                  <PostInsightsSheet
                    postId={postId || null}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                  />
                </Suspense>,
              );
              bottomSheet.openBottomSheet(true);
            },
          },
        ]
      : [];

    const saveActionGroup: ActionMenuAction[] = [];

    if (!canUsePrivateApi) {
      // Signed out: nothing below applies. Every row is a write on the
      // viewer's account, and `isOwner` is false without a session.
    } else if (!isSaved) {
      saveActionGroup.push({
        icon: <RiBookmarkLine width={20} height={20} fill={theme.colors.textSecondary} />,
        label: t('postActions.save'),
        onPress: onSave,
      });
    } else {
      saveActionGroup.push({
        icon: <RiBookmarkFill width={20} height={20} fill={theme.colors.textSecondary} />,
        label: t('postActions.unsave'),
        onPress: onSave,
      });
    }

    // Edit action — owner only, and the deadline depends on WHO published.
    //
    // A personal post keeps its 30-minute window: the bargain there is that
    // the change lands before the post has really been read, so there is
    // nothing to disclose. A CHANNEL is a publication and its posts stay
    // editable for their whole life, because every change to the body
    // appends to a public correction trail the reader can open — the trail
    // is what buys the permanence, so the window has nothing left to
    // protect. `isOwner` is server-computed and is already true for a
    // channel post's writer, so it needs no widening here.
    if (isOwner) {
      const isChannelPost = viewPost?.user?.kind === 'channel';
      const createdAtRaw = viewPost?.metadata?.createdAt;
      const createdAtMs = createdAtRaw ? new Date(createdAtRaw).getTime() : 0;
      const withinEditWindow = createdAtMs > 0 && Date.now() - createdAtMs < 30 * 60 * 1000;
      if (isChannelPost || withinEditWindow) {
        saveActionGroup.push({
          icon: <Ionicons name="create-outline" size={20} color={theme.colors.textSecondary} />,
          label: t('postActions.edit'),
          onPress: () => router.push(`/compose?editPostId=${postId}`),
        });
      }
    }

    if (isOwner) {
      saveActionGroup.push({
        icon: isPinned ? (
          <RiUnpinLine width={20} height={20} fill={theme.colors.textSecondary} />
        ) : (
          <RiPushpinLine width={20} height={20} fill={theme.colors.textSecondary} />
        ),
        label: isPinned ? t('postActions.unpinFromProfile') : t('postActions.pinToProfile'),
        onPress: async () => {
          const nextPinned = !isPinned;
          try {
            await feedService.updatePostSettings(postId, { isPinned: nextPinned });
            updatePostEverywhere(postId, (prev) => ({
              ...prev,
              metadata: { ...prev.metadata, isPinned: nextPinned },
            }));
            const authorId = viewPost?.user?.id;
            if (authorId) {
              queryClient.invalidateQueries({
                queryKey: viewerQueryKeys.pinnedPost(viewerId, authorId),
              });
            }
          } catch {
            toast(
              isPinned ? t('postActions.failedToUnpinPost') : t('postActions.failedToPinPost'),
              { type: 'error' },
            );
          }
        },
      });
    }

    // Moving a post between the author's own lanes sits beside pinning, and
    // for the same reason: neither is an EDIT. There is no 30-minute window
    // here — the write changes no text, does not federate, emits no MTN
    // record and never sets `isEdited` (see `updatePostLane`) — so it is
    // offered for the life of the post, exactly like pin/unpin.
    //
    // A reply or a boost cannot carry a lane at all, so the action is absent
    // rather than present-and-failing.
    const isReplyOrBoost = Boolean(viewPost?.parentPostId) || Boolean(viewPost?.boost);
    if (isOwner && !isReplyOrBoost) {
      saveActionGroup.push({
        icon: <RiNodeTree width={20} height={20} fill={theme.colors.textSecondary} />,
        label: t('lanes.postActions.moveToLane', { defaultValue: 'Move to lane…' }),
        onPress: () => {
          bottomSheet.setBottomSheetContent(
            <Suspense fallback={null}>
              <LanePickerSheet
                selectedLaneId={viewPost?.lane?.id ?? null}
                onSelect={async (nextLaneId) => {
                  try {
                    const lane = await lanesService.setPostLane(postId, nextLaneId);
                    updatePostEverywhere(postId, (prev) => ({
                      ...prev,
                      lane: lane ?? undefined,
                    }));
                    // The chip flips instantly through the store
                    // above; WHICH profile tab the post now sits
                    // on is server-ordered and paged, so both
                    // post-list caches have to be told.
                    noteLaneListsChanged('assignment');
                  } catch (e) {
                    logger.error('Failed to move post to lane', e);
                    toast(
                      t('lanes.postActions.moveFailed', {
                        defaultValue: 'Failed to move this post',
                      }),
                      { type: 'error' },
                    );
                  }
                }}
                onClose={() => bottomSheet.openBottomSheet(false)}
              />
            </Suspense>,
          );
          bottomSheet.openBottomSheet(true);
        },
      });
    }

    if (isOwner) {
      const isHidden = Boolean(viewPost?.metadata?.hideEngagementCounts);
      saveActionGroup.push({
        icon: <RiEyeOffLine width={20} height={20} fill={theme.colors.textSecondary} />,
        label: isHidden
          ? t('postActions.showEngagementCounts')
          : t('postActions.hideEngagementCounts'),
        onPress: async () => {
          const nextHidden = !isHidden;
          try {
            await feedService.updatePostSettings(postId, { hideEngagementCounts: nextHidden });
            updatePostEverywhere(postId, (prev) => ({
              ...prev,
              metadata: { ...prev.metadata, hideEngagementCounts: nextHidden },
            }));
          } catch {
            toast(t('postActions.failedToUpdateEngagement'), { type: 'error' });
          }
        },
      });
    }

    if (isOwner) {
      saveActionGroup.push({
        icon: <RiArrowRightSLine width={20} height={20} fill={theme.colors.textSecondary} />,
        label: t('postActions.replyOptions'),
        onPress: () => {
          bottomSheet.setBottomSheetContent(
            <Suspense fallback={null}>
              <ReplySettingsSheet
                replyPermission={viewPost?.metadata?.replyPermission ?? ['anyone']}
                onReplyPermissionChange={async (permission) => {
                  try {
                    await feedService.updatePostSettings(postId, { replyPermission: permission });
                    updatePostEverywhere(postId, (prev) => ({
                      ...prev,
                      metadata: { ...prev.metadata, replyPermission: permission },
                    }));
                  } catch {
                    toast(t('postActions.failedToUpdateReplyPermissions'), { type: 'error' });
                  }
                }}
                quotesDisabled={viewPost?.metadata?.quotesDisabled || false}
                onQuotesDisabledChange={async (disabled) => {
                  try {
                    await feedService.updatePostSettings(postId, { quotesDisabled: disabled });
                    updatePostEverywhere(postId, (prev) => ({
                      ...prev,
                      metadata: { ...prev.metadata, quotesDisabled: disabled },
                    }));
                  } catch {
                    toast(t('postActions.failedToUpdateQuoteSettings'), { type: 'error' });
                  }
                }}
                onClose={() => bottomSheet.openBottomSheet(false)}
              />
            </Suspense>,
          );
          bottomSheet.openBottomSheet(true);
        },
      });
    }

    const stopSharingAction = canStopSharing
      ? [
          {
            icon: <Ionicons name="close-circle-outline" size={20} color={theme.colors.error} />,
            label: t('collab.stopSharing', { defaultValue: 'Stop sharing' }),
            onPress: async () => {
              const confirmed = await confirmDialog({
                title: t('collab.stopSharingTitle', { defaultValue: 'Stop sharing this post?' }),
                message: t('collab.stopSharingMessage', {
                  defaultValue:
                    'This post will be removed from your profile. Other collaborators can still see it.',
                }),
                okText: t('collab.stopSharing', { defaultValue: 'Stop sharing' }),
                cancelText: t('postActions.cancel'),
                destructive: true,
              });
              if (!confirmed || !postId) return;
              try {
                const result = await feedService.stopCollabSharing(postId);
                if (result.post) {
                  updatePostEverywhere(postId, () => result.post as HydratedPost);
                } else {
                  removePostEverywhere(postId);
                }
                toast(
                  t('collab.stopSharingSuccess', { defaultValue: 'You stopped sharing this post' }),
                  { type: 'success' },
                );
              } catch (e) {
                logger.error('Stop sharing failed', e);
                toast(t('collab.stopSharingFailed', { defaultValue: 'Failed to stop sharing' }), {
                  type: 'error',
                });
              }
            },
            color: theme.colors.error,
          },
        ]
      : [];

    const deleteAction = isOwner
      ? [
          {
            icon: <RiDeleteBinLine width={20} height={20} fill={theme.colors.error} />,
            label: t('postActions.delete'),
            onPress: handleDelete,
            color: theme.colors.error,
          },
        ]
      : [];

    const articleAction = hasArticle
      ? [
          {
            icon: <RiFileList2Line width={20} height={20} fill={theme.colors.textSecondary} />,
            label: t('post.viewArticle', { defaultValue: 'View article' }),
            onPress: () => {
              onOpenArticle();
            },
          },
        ]
      : [];

    const sourcesAction = hasSources
      ? [
          {
            icon: <RiLinksLine width={20} height={20} fill={theme.colors.textSecondary} />,
            label: t('post.viewSources', { defaultValue: 'View sources' }),
            onPress: () => {
              onOpenSources();
            },
          },
        ]
      : [];

    const handleMuteUser = async () => {
      const userId = viewPost?.user?.id;
      const username =
        getNormalizedUserHandle(viewPost?.user) || viewPost?.user?.name?.displayName || 'this user';

      if (!userId) {
        toast(t('postActions.unableToMuteUser'), { type: 'error' });
        return;
      }

      const confirmed = await confirmDialog({
        title: t('postActions.muteUser', { username }),
        message: t('postActions.muteConfirmMessage', { username }),
        okText: t('postActions.mute'),
        cancelText: t('postActions.cancel'),
        destructive: false,
      });

      if (!confirmed) return;

      const success = await muteService.muteUser(userId, viewerId);
      if (success) {
        toast(t('postActions.userMuted', { username }), { type: 'success' });
      } else {
        toast(t('postActions.failedToMuteUser'), { type: 'error' });
      }
    };

    const handleReportPost = () => {
      bottomSheet.setBottomSheetContent(
        <Suspense fallback={null}>
          <ReportModal
            visible={true}
            onClose={() => bottomSheet.openBottomSheet(false)}
            onSubmit={async (categories, details) => {
              const success = await reportService.reportPost(postId, categories, details);
              if (success) {
                toast(t('postActions.thankYouReport'), { type: 'success' });
              } else {
                toast(t('postActions.failedToSubmitReport'), { type: 'error' });
              }
            }}
          />
        </Suspense>,
      );
      bottomSheet.openBottomSheet(true);
    };

    const postLane = viewPost?.lane;

    /**
     * Silence ONE track of one publisher, without unfollowing them — the
     * reader's half of the feature.
     *
     * Narrower than muting the author on purpose, so it is offered first: a
     * reader who does not want the dev notes still wants the person.
     */
    const handleMuteLane = async (username: string) => {
      if (!postLane) return;

      const confirmed = await confirmDialog({
        title: t('lanes.postActions.muteLane', {
          lane: postLane.name,
          username,
          defaultValue: 'Mute «{{lane}}» from @{{username}}',
        }),
        message: t('lanes.postActions.muteLaneConfirm', {
          lane: postLane.name,
          username,
          defaultValue:
            'Posts on «{{lane}}» stop appearing in your feeds. You keep following @{{username}}, and everything else they post still reaches you.',
        }),
        okText: t('postActions.mute'),
        cancelText: t('postActions.cancel'),
        destructive: false,
      });
      if (!confirmed) return;

      try {
        await lanesService.mute(postLane.id);
        // A mute is a filter over EVERY feed this reader opens, so the
        // held feed reads all have to be revalidated.
        noteLaneListsChanged('mute');
        toast(
          t('lanes.postActions.laneMuted', {
            lane: postLane.name,
            defaultValue: '«{{lane}}» muted',
          }),
          { type: 'success' },
        );
      } catch (e) {
        logger.error('Failed to mute lane', e);
        toast(t('lanes.postActions.muteLaneFailed', { defaultValue: 'Failed to mute this lane' }), {
          type: 'error',
        });
      }
    };

    const muteReportAction: ActionMenuAction[] = [];

    if (!isOwner && canUsePrivateApi) {
      const username =
        getNormalizedUserHandle(viewPost?.user) || viewPost?.user?.name?.displayName || 'user';
      if (postLane) {
        muteReportAction.push({
          icon: <RiMicOffLine width={20} height={20} fill={theme.colors.textSecondary} />,
          label: t('lanes.postActions.muteLane', {
            lane: postLane.name,
            username,
            defaultValue: 'Mute «{{lane}}» from @{{username}}',
          }),
          onPress: () => handleMuteLane(username),
        });
      }
      muteReportAction.push({
        icon: <RiMicOffLine width={20} height={20} fill={theme.colors.textSecondary} />,
        label: t('postActions.muteUser', { username }),
        onPress: handleMuteUser,
      });

      muteReportAction.push({
        icon: <RiSpamLine width={20} height={20} fill={theme.colors.error} />,
        label: t('postActions.reportPost'),
        onPress: handleReportPost,
        color: theme.colors.error,
      });
    }

    const addToListAction: ActionMenuAction[] = [];
    const authorId = viewPost?.user?.id;
    if (!isOwner && authorId && canUsePrivateApi) {
      const authorHandle = getNormalizedUserHandle(viewPost?.user) || '';
      addToListAction.push({
        icon: <RiListUnordered width={20} height={20} fill={theme.colors.textSecondary} />,
        label: t('lists.addTo.menuItem', { defaultValue: 'Add/remove from lists' }),
        onPress: () => {
          bottomSheet.setBottomSheetContent(
            <Suspense fallback={null}>
              <AddToListSheet
                targetUserId={authorId}
                targetLabel={authorHandle ? `@${authorHandle}` : undefined}
                onClose={() => bottomSheet.openBottomSheet(false)}
              />
            </Suspense>,
          );
          bottomSheet.openBottomSheet(true);
        },
      });
    }

    // A community moderator's two actions on a post written in it. Removing it
    // takes it out of the community — it stays its author's — and banning its
    // author refuses their posts there from now on. Neither is offered on the
    // moderator's own post's author (a moderator cannot ban themselves).
    const communityModerationAction: ActionMenuAction[] = [];
    const community = viewPost?.community;
    if (moderatesCommunity && community?.id && postId) {
      const communityHandle = getNormalizedUserHandle(community) || '';
      const authorHandle = getNormalizedUserHandle(viewPost?.user) || '';
      communityModerationAction.push({
        icon: <RiEyeOffLine width={20} height={20} fill={theme.colors.textSecondary} />,
        label: t('communities.postActions.remove', {
          community: communityHandle,
          defaultValue: 'Remove from !{{community}}',
        }),
        onPress: async () => {
          const confirmed = await confirmDialog({
            title: t('communities.postActions.removeTitle', {
              defaultValue: 'Remove this post from the community?',
            }),
            message: t('communities.postActions.removeMessage', {
              defaultValue:
                'It stays on its author’s profile, but leaves the community and its members’ feeds, here and on the fediverse.',
            }),
            okText: t('communities.postActions.removeConfirm', { defaultValue: 'Remove' }),
            cancelText: t('postActions.cancel'),
            destructive: true,
          });
          if (!confirmed) return;
          try {
            await communityService.removePost(community.id, postId);
            updatePostEverywhere(postId, (prev) => ({ ...prev, community: undefined }));
            toast(
              t('communities.postActions.removed', { defaultValue: 'Removed from the community' }),
              {
                type: 'success',
              },
            );
          } catch (e) {
            logger.error('Failed to remove a post from its community', e);
            toast(
              t('communities.postActions.removeFailed', {
                defaultValue: 'Could not remove the post',
              }),
              { type: 'error' },
            );
          }
        },
      });
      const authorId = viewPost?.user?.id;
      if (authorId && authorId !== viewerId) {
        communityModerationAction.push({
          icon: <RiSpamLine width={20} height={20} fill={theme.colors.error} />,
          label: t('communities.postActions.ban', {
            username: authorHandle,
            community: communityHandle,
            defaultValue: 'Ban @{{username}} from !{{community}}',
          }),
          color: theme.colors.error,
          onPress: async () => {
            const confirmed = await confirmDialog({
              title: t('communities.postActions.banTitle', {
                username: authorHandle,
                defaultValue: 'Ban @{{username}}?',
              }),
              message: t('communities.postActions.banMessage', {
                defaultValue:
                  'They can no longer post or reply in this community. What they already posted stays until you remove it.',
              }),
              okText: t('communities.postActions.banConfirm', { defaultValue: 'Ban' }),
              cancelText: t('postActions.cancel'),
              destructive: true,
            });
            if (!confirmed) return;
            try {
              await communityService.ban(community.id, authorId);
              void queryClient.invalidateQueries({
                queryKey: viewerQueryKeys.communityBans(viewerId, community.id),
              });
              toast(
                t('communities.postActions.banned', { defaultValue: 'Banned from the community' }),
                {
                  type: 'success',
                },
              );
            } catch (e) {
              logger.error('Failed to ban a member from a community', e);
              toast(
                t('communities.postActions.banFailed', { defaultValue: 'Could not ban them' }),
                {
                  type: 'error',
                },
              );
            }
          },
        });
      }
    }

    const copyLinkAction = [
      {
        icon: <RiLinkM width={20} height={20} fill={theme.colors.textSecondary} />,
        label: t('postActions.copyLink'),
        onPress: async () => {
          try {
            if (Platform.OS === 'web') {
              await navigator.clipboard.writeText(postUrl);
            } else {
              await Clipboard.setStringAsync(postUrl);
            }
          } catch {
            logger.warn('Failed to copy link');
          }
        },
      },
    ];

    return {
      insightsAction,
      saveActionGroup,
      addToListAction,
      stopSharingAction,
      deleteAction,
      articleAction,
      sourcesAction,
      muteReportAction,
      communityModerationAction,
      copyLinkAction,
    };
  }
}
