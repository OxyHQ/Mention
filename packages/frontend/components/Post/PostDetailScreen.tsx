import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Text, Platform } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@oxy.so/bloom/accordion';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiEqualizerLine } from '@oxy.so/bloom/icons/RiEqualizerLine';
import { useRouter } from '@/lib/navigation/router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { usePostReadAccess } from '@/hooks/usePostReadAccess';
import { EmptyState } from '@/components/common/EmptyState';
import PostItem from '@/components/Feed/PostItem';
import Feed from '@/components/Feed/Feed';
import { FeedHeader } from '@/components/Feed/FeedHeader';
import { Screen } from '@oxy.so/bloom/screen';
import { PageFooter } from '@oxy.so/bloom/page-footer';
import {
  useThreadPreferences,
  useThreadPreferencesStore,
  SORT_TO_API,
} from '@/hooks/useThreadPreferences';
import { prefetchFeed } from '@/hooks/useFeedQuery';
import { useQueryClient } from '@tanstack/react-query';
import {
  applyServerViewCounts,
  getCachedAncestorChain,
  usePostsStore,
  usePostSelector,
} from '@/stores/postsStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import ReplyPreferencesSheet from '@/components/ReplyPreferencesSheet';
import type { FeedType, HydratedPost, Reply, FeedBoost as Boost } from '@mention/shared-types';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { insightsService } from '@/services/insightsService';
import { feedService } from '@/services/feedService';
import { socketService } from '@/services/socketService';
import { SEO } from '@/components/SEO';
import { WEB_BASE_URL } from '@/config';
import { readServerSEO } from '@/lib/seoHandoff';
import { postAcceptsReplies } from '@/utils/postReplies';
import { createLogger } from '@oxy.so/core/logger';
import { getFollowingCachedPost } from '@/modules/mention-widgets';

type PostDetailEntity = HydratedPost | Reply | Boost;

const postDetailLogger = createLogger('PostDetail');

/** Breathing room (px) below the last reply, before the pinned composer / screen edge. */
const FEED_BOTTOM_PADDING = 16;

// Hard cap on how far up the reply chain we walk when building the ancestor
// thread, guarding against a runaway/cyclic chain. Threads are short in practice
// (a handful of hops); this is purely a safety ceiling.
const MAX_ANCESTOR_DEPTH = 30;

interface PostDetailScreenProps {
  postId: string;
  onBack?: () => void;
}

/**
 * Read the replies for the route's post while the post itself and the viewer's
 * supervision are still loading, so the three requests leave together instead
 * of one after another. Data only: nothing renders until the screen's access
 * gate allows it, and the server re-checks the viewer on every read.
 */
function usePrefetchReplies(postId: string) {
  const queryClient = useQueryClient();
  const { user, isAuthenticated, isAuthResolved, canUsePrivateApi } = useAuth();
  const sortOrder = useThreadPreferencesStore((state) => state.sortOrder);
  const treeView = useThreadPreferencesStore((state) => state.treeView);
  const sortLoaded = useThreadPreferencesStore((state) => state.loaded);
  const viewerId = isAuthenticated ? user?.id : undefined;
  // The same viewer the feed will read for: resolved, and signed in with a
  // usable session or signed out.
  const viewerReady = isAuthResolved && (isAuthenticated ? canUsePrivateApi && !!viewerId : true);

  useEffect(() => {
    if (!postId || !viewerReady || !sortLoaded) return;
    // A boost's replies are its original's; a cached boost names it.
    const boosted = usePostsStore.getState().getPostFromDb(postId)?.boost?.originalPost?.id;
    const target = boosted ? String(boosted) : postId;
    prefetchFeed(queryClient, {
      type: 'replies' as FeedType,
      filters: {
        postId: target,
        parentPostId: target,
        sort: SORT_TO_API[sortOrder],
        includeNestedReplies: treeView,
      },
      viewerId,
    });
  }, [postId, viewerReady, sortLoaded, sortOrder, treeView, viewerId, queryClient]);
}

export default function PostDetailScreen({ postId: id, onBack }: PostDetailScreenProps) {
  // Supervision, the post and its replies load at the same time; only what is
  // SHOWN waits for the access gate (see the returns below).
  const access = usePostReadAccess(id ? String(id) : '');
  const requiresFreshReads = access.supervised;
  usePrefetchReplies(id ? String(id) : '');
  const router = useRouter();
  const safeBack = useSafeBack();
  const getPostById = usePostsStore((state) => state.getPostById);
  const revalidatePostById = usePostsStore((state) => state.revalidatePostById);
  const { user } = useAuth();
  const viewerId = user?.id;
  const theme = useTheme();
  const { t } = useTranslation();
  const { treeView, sortOrder } = useThreadPreferences();
  const { openBottomSheet, setBottomSheetContent } = React.useContext(BottomSheetContext);

  // The cached post for this id, read reactively from the shared cache (re-reads
  // whenever the cache mutates: background revalidation, optimistic like/boost,
  // etc. — compiler-safe `useSyncExternalStore` under the hood). Seeded by the
  // feed when the post was already visible, so the detail screen paints
  // instantly instead of issuing a cold blocking fetch on open.
  const cachedPost: PostDetailEntity | null = usePostSelector(id ? String(id) : undefined);

  // `post` holds either the cached post (instant) or a network-fetched post
  // (cache miss). When the cache has the post, it is the source of truth and
  // stays in sync via `cachedPost`; on a cache miss we fall back to the fetched
  // value held in `fetchedPost`.
  const [fetchedPost, setFetchedPost] = useState<PostDetailEntity | null>(null);
  const post = cachedPost ?? fetchedPost;

  // The full ancestor chain above the focused post, ordered ROOT FIRST … the
  // immediate parent LAST. Rendered as one connected thread above the focused
  // post (Bluesky-style). Empty for a root post (no parent).
  const [ancestors, setAncestors] = useState<PostDetailEntity[]>(() =>
    requiresFreshReads
      ? []
      : (getCachedAncestorChain(
          id ? String(id) : '',
          cachedPost?.parentPostId,
        ) as PostDetailEntity[]),
  );
  // The author's self-thread continuation spine BELOW the focused post, ordered
  // root-first (c1 … cN). Populated only when the focused post is a self-thread
  // root (the backend returns [] otherwise), so a non-thread post is unchanged.
  // Its own connected group, below the focused post and its metadata.
  const [continuations, setContinuations] = useState<PostDetailEntity[]>([]);
  const [threadPositions, setThreadPositions] = useState<
    ReadonlyMap<string, { index: number; total: number }>
  >(new Map());
  const [collapsedThreadId, setCollapsedThreadId] = useState<string | null>(null);
  const continuationsExpanded = collapsedThreadId !== id;
  // Only block first paint when there is no cached post to render. A cache hit
  // paints immediately and revalidates in the background (stale-while-revalidate).
  const [loading, setLoading] = useState(() => !cachedPost);
  const [error, setError] = useState<string | null>(null);
  const [repliesReloadKey] = useState(0);

  // The TAIL of the OP's self-thread — the last continuation (cN). Undefined for
  // a non-thread post (no continuation spine).
  const threadTailId =
    continuations.length > 0 ? String(continuations[continuations.length - 1].id) : undefined;

  // A boost (`type:'boost'`) is its OWN post with an empty body whose content is
  // the original it boosted — so `/p/<boostId>` renders as the booster's post
  // with the original embedded as a nested sub-card (the same way the feed row
  // renders a boost). A boost has no replies of its own; replies attach to the
  // original, so both reply targets below resolve to the original's id.
  const boostOriginalId = post?.boost?.originalPost?.id
    ? String(post.boost.originalPost.id)
    : undefined;

  // Target that drives the REPLIES FEED query: the focused post itself (the
  // self-thread ROOT when this is a thread). The backend expands a self-thread
  // root into its whole continuation spine and returns external replies to ANY
  // spine node (root … cN), EXCLUDING the OP's own continuations — so this must be
  // the root, NOT the tail. For a non-thread post the root IS the focused post.
  const repliesQueryTargetId = boostOriginalId ?? String(id);

  // Target a NEW reply attaches to: the thread TAIL (cN) when this is a self-thread
  // (Bluesky — reply to the latest thread post), else the focused post. Because the
  // spine-aware replies feed includes the tail's children, a reply composed here
  // surfaces in the replies list.
  const composeReplyTargetId = boostOriginalId ?? threadTailId ?? String(id);

  // Memoize filters for replies feed
  const feedFilters = useMemo(
    () => ({
      postId: repliesQueryTargetId,
      parentPostId: repliesQueryTargetId,
      sort: SORT_TO_API[sortOrder],
      includeNestedReplies: treeView,
    }),
    [repliesQueryTargetId, sortOrder, treeView],
  );

  const feedContentStyle = useMemo(() => ({ paddingBottom: FEED_BOTTOM_PADDING }), []);

  const openReplyPreferences = useCallback(() => {
    setBottomSheetContent(<ReplyPreferencesSheet />);
    openBottomSheet(true);
  }, [setBottomSheetContent, openBottomSheet]);

  const handleOpenReply = useCallback(() => {
    // A new reply attaches to the thread tail (or the focused post / boost
    // original), never to the boost record itself.
    if (composeReplyTargetId) router.push(`/compose?replyToPostId=${composeReplyTargetId}`);
  }, [composeReplyTargetId]);

  // Watch this post's engagement counters for as long as it is on screen.
  //
  // This is the one surface where a stale count is conspicuous: the reader is
  // looking at a single post, often for minutes, and someone else's like or
  // reply lands under their eyes. Feeds deliberately do NOT subscribe — a
  // screenful of posts would be a room each, and a number a few seconds old in
  // a scrolling list is not the same problem.
  //
  // A genuine external subscription, hence an effect. The server re-checks
  // that this viewer may read the post before admitting the socket, so the id
  // in the URL grants nothing on its own; like everything the reader sees, it
  // waits for the access gate.
  const accessAllowed = access.allowed;
  useEffect(() => {
    const postId = String(id ?? '');
    if (!postId || !viewerId || !accessAllowed) return;

    socketService.joinPost(postId);
    return () => socketService.leavePost(postId);
  }, [id, viewerId, accessAllowed]);

  // Track the view once the reader is shown the post. The ack carries the
  // post's fresh total — the server reads it back specifically to return it —
  // so it goes into the shared cache rather than being dropped: this screen
  // renders that number, and the view it just recorded is precisely the one it
  // would otherwise be missing.
  useEffect(() => {
    const postId = String(id ?? '');
    if (!postId || !viewerId || !accessAllowed) return;
    insightsService
      .trackPostView(postId)
      .then((ack) => applyServerViewCounts({ [postId]: ack.viewsCount }))
      .catch((error) => {
        // View tracking is best-effort and must never reach the reader, but a
        // count that silently stops updating should still be diagnosable.
        postDetailLogger.debug('Post view tracking failed', { error });
      });
  }, [id, viewerId, accessAllowed]);

  // Load the post. When the feed already cached it, the post is rendered
  // synchronously above (`cachedPost`) and this effect only revalidates it in
  // the background (stale-while-revalidate) — no spinner, no blocking fetch.
  // On a true cache miss it does a single blocking fetch.
  useEffect(() => {
    if (!id) {
      setError('Post ID is required');
      setLoading(false);
      return;
    }

    let cancelled = false;
    const postId = String(id);
    const hadCache = !!usePostsStore.getState().getPostFromDb(postId);

    // Drop any ancestor chain belonging to a previously-viewed post so the new
    // focused post never momentarily renders under stale parents on navigation.
    // Reset to THIS post's cached prefix rather than to nothing: on mount the
    // state initializer already put it there, and resetting to `[]` here would
    // blank it for a frame before the async walk put the same rows back.
    setAncestors(
      requiresFreshReads
        ? []
        : (getCachedAncestorChain(
            postId,
            usePostsStore.getState().getPostFromDb(postId)?.parentPostId,
          ) as PostDetailEntity[]),
    );
    // Likewise drop the previous post's continuation spine and numbering.
    setContinuations([]);
    setThreadPositions(new Map());

    // Read the complete author spine even when opening one of its continuations,
    // so "2/3" does not become "1/2" when the focused post changes. Only the root
    // renders the continuation group; reply targets and ancestor loading stay the same.
    const loadContinuations = (target: PostDetailEntity | null | undefined) => {
      if (!target?.metadata?.isThread) return;
      const rootId = target.context?.parentThreadId ?? postId;
      feedService
        .getThreadContinuations(rootId)
        .then((spine) => {
          if (cancelled) return;
          setContinuations(rootId === postId ? spine : []);
          // A missing/hidden part means the visible list cannot establish a
          // trustworthy position. Omit numbering instead of inventing a total.
          const ids = [rootId, ...spine.map((part) => String(part.id))];
          if (spine.length > 0 && spine.every((part, index) => part.parentPostId === ids[index])) {
            setThreadPositions(
              new Map(
                ids.map((partId, index) => [partId, { index: index + 1, total: ids.length }]),
              ),
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setContinuations([]);
            setThreadPositions(new Map());
          }
        });
    };

    // Walk the reply chain UP from the focused post to the root, building the
    // ordered ancestor array (root first … immediate parent last). Each hop
    // reads the shared cache first and only fetches on a miss, so a fully
    // cached chain resolves in one tight pass. Resilient + bounded:
    //   - a missing/deleted ancestor just stops the chain (render what loaded);
    //   - a cycle (id already visited) breaks the walk;
    //   - the walk is capped at MAX_ANCESTOR_DEPTH hops.
    // Boosts have no `parentPostId`, so they yield an empty chain — the boost
    // renders standalone with its original embedded (reply targets resolve to
    // the original via `boostOriginalId`, unchanged).
    const loadAncestors = async (startParentId: string | undefined) => {
      if (!startParentId) {
        if (!cancelled) setAncestors([]);
        return;
      }
      const chain: PostDetailEntity[] = []; // bottom-up: immediate parent first
      const visited = new Set<string>([postId]);
      let nextId: string | undefined = startParentId;
      let depth = 0;

      while (nextId && depth < MAX_ANCESTOR_DEPTH) {
        if (visited.has(nextId)) break; // cycle guard
        visited.add(nextId);

        let ancestor: PostDetailEntity | null = requiresFreshReads
          ? null
          : usePostsStore.getState().getPostFromDb(nextId);
        if (!ancestor) {
          try {
            ancestor = await (requiresFreshReads
              ? revalidatePostById(nextId)
              : getPostById(nextId));
          } catch {
            // Missing/deleted ancestor — stop and keep what we have.
            break;
          }
        }
        if (cancelled) return;
        if (!ancestor) break;

        chain.push(ancestor);
        nextId = ancestor.parentPostId ? String(ancestor.parentPostId) : undefined;
        depth++;
      }

      if (!cancelled) setAncestors(chain.reverse()); // root first
    };

    const run = async () => {
      setError(null);

      if (hadCache) {
        // Instant paint already happened from `cachedPost`. Revalidate in
        // the background so engagement/viewer state is fresh; the reactive
        // store read (`cachedPost`) picks up the refreshed post.
        const cached = usePostsStore.getState().getPostFromDb(postId);
        loadContinuations(cached);
        loadAncestors(cached?.parentPostId);
        // The supervised entry gate has already read this post with current authority.
        if (requiresFreshReads) return;
        revalidatePostById(postId).then((fresh) => {
          if (cancelled) return;
          if (!fresh && !usePostsStore.getState().getPostFromDb(postId)) {
            setFetchedPost(null);
            setAncestors([]);
            setContinuations([]);
            setError(t('safety.contentUnavailable'));
            return;
          }
          // A post is never re-parented, so the revalidated copy almost
          // always names the parent the walk above already started from —
          // and re-walking it re-issues a fetch for every uncached hop for
          // an identical chain. The one case worth the second walk is a
          // cached copy that was PARTIAL and carried no `parentPostId`
          // (the shared cache holds degraded rows; see `isRenderableBoost`
          // in `postsStore`), which is why this compares rather than
          // deleting the branch outright.
          if (cancelled || !fresh?.parentPostId) return;
          if (fresh.parentPostId === cached?.parentPostId) return;
          loadAncestors(fresh.parentPostId);
        });
        return;
      }

      // Cache miss — first consult the Android widget's account-scoped,
      // persistent copy. A cold app launched from a card has no JS/SQLite
      // feed cache yet, but the widget necessarily has this exact hydrated
      // post already; painting it before revalidation avoids a redundant
      // blocking round trip on the tap path.
      try {
        setLoading(true);
        const widgetJson = await getFollowingCachedPost(postId);
        if (cancelled) return;
        if (widgetJson) {
          try {
            const widgetPost = JSON.parse(widgetJson) as HydratedPost;
            if (String(widgetPost.id) === postId) {
              usePostsStore.getState().cachePosts([widgetPost]);
              setFetchedPost(widgetPost);
              setLoading(false);
              loadContinuations(widgetPost);
              loadAncestors(widgetPost.parentPostId);
              void revalidatePostById(postId).then((fresh) => {
                if (cancelled) return;
                if (!fresh && !usePostsStore.getState().getPostFromDb(postId)) {
                  setFetchedPost(null);
                  setAncestors([]);
                  setContinuations([]);
                  setError(t('safety.contentUnavailable'));
                }
              });
              return;
            }
          } catch (error) {
            postDetailLogger.debug('Ignoring unreadable widget post cache', { error });
          }
        }

        // True cache miss: perform the normal blocking fetch.
        const response = await getPostById(postId);
        if (cancelled) return;
        setFetchedPost(response);
        loadContinuations(response);
        loadAncestors(response?.parentPostId);
      } catch {
        if (!cancelled) setError('Failed to load post');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [id, getPostById, revalidatePostById, viewerId, requiresFreshReads, t]);

  const handleBack = () => {
    if (onBack) onBack();
    else safeBack();
  };

  // Server discovery policy includes author privacy, boost origins and remote
  // safety flags absent from this DTO. Never infer indexing from visibility alone.
  const [initialSEO] = useState(() =>
    Platform.OS === 'web' && typeof document !== 'undefined'
      ? readServerSEO(document, window.location.pathname)
      : undefined,
  );
  const postUrl = `${WEB_BASE_URL}/p/${encodeURIComponent(String(id))}`;
  const locallyRestricted = Boolean(
    post &&
      (('visibility' in post && post.visibility !== 'public') ||
        ('status' in post && post.status && post.status !== 'published') ||
        ('visibility' in post.metadata && post.metadata.visibility !== 'public') ||
        ('status' in post.metadata &&
          post.metadata.status &&
          post.metadata.status !== 'published') ||
        post.metadata?.isSensitive ||
        post.metadata?.spoilerText),
  );
  const authoritativeSEO =
    initialSEO?.url === postUrl && !locallyRestricted ? initialSEO : undefined;
  const postAuthor = post?.user?.name?.displayName || t('common.someone');
  const postTitle =
    authoritativeSEO?.title ||
    t('seo.post.title', { author: postAuthor, defaultValue: `${postAuthor} on Mention` });
  const postDescription =
    authoritativeSEO?.description ||
    t('seo.post.description', { defaultValue: 'View this post on Mention' });
  const postImage = authoritativeSEO?.image;

  // List header for Feed: ancestor thread + focused post + the OP's self-thread
  // spine. The reply composer is NOT part of it — it is pinned to the bottom of
  // the Screen footer slot below.
  const listHeader = useMemo(() => {
    if (!post) return null;
    const hasAncestors = ancestors.length > 0;
    const hasContinuations = continuations.length > 0;
    return (
      <View>
        {/* Ancestor chain rendered top-to-bottom (root first) as ONE
                    connected thread. Each ancestor draws the thread line DOWN from
                    its avatar (`isThreadParent`) and, for every hop below the root,
                    receives the incoming line from above (`isThreadChild`), so the
                    line is continuous root → … → immediate parent. `attachedBelow`
                    drops each ancestor's bottom border/padding so they connect flush
                    with no separators between them or into the focused post. */}
        {ancestors.map((ancestor, index) => (
          <PostItem
            key={String(ancestor.id ?? index)}
            post={ancestor}
            threadPosition={threadPositions.get(String(ancestor.id))}
            isThreadParent
            isThreadChild={index > 0}
            attachedBelow
            onReply={handleOpenReply}
          />
        ))}

        {/* Ancestors end at the focused avatar; no rail crosses its full-width body. */}
        <PostItem
          post={post}
          threadPosition={threadPositions.get(String(post.id))}
          isPostDetail
          isThreadChild={hasAncestors}
          isThreadLastChild={hasAncestors}
          onReply={handleOpenReply}
        />

        {hasContinuations && (
          <Accordion
            value={continuationsExpanded ? 'continuations' : undefined}
            onValueChange={(value) => setCollapsedThreadId(value ? null : id)}
          >
            <AccordionItem value="continuations" className="border-0">
              <AccordionTrigger className="px-3 py-3" textStyle={{ fontSize: 13 }}>
                {t('post.threadContinuation', {
                  defaultValue: 'Thread continuation ({{count}})',
                  count: continuations.length,
                })}
              </AccordionTrigger>
              <AccordionContent contentClassName="p-0">
                {continuations.map((continuation, index) => {
                  const isLast = index === continuations.length - 1;
                  return (
                    <PostItem
                      key={String(continuation.id)}
                      post={continuation}
                      threadPosition={threadPositions.get(String(continuation.id))}
                      isThreadChild={index > 0}
                      isThreadParent={!isLast}
                      isThreadLastChild={isLast}
                      attachedBelow={!isLast}
                      onReply={handleOpenReply}
                    />
                  );
                })}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </View>
    );
  }, [
    post,
    ancestors,
    continuations,
    threadPositions,
    continuationsExpanded,
    id,
    t,
    handleOpenReply,
  ]);

  const header = (
    <PageHeader
      title={
        post && 'metadata' in post && post.metadata?.isThread ? 'Thread' : t('screens.post.title')
      }
      headingLevel={2}
      onBack={handleBack}
      backLabel={t('common.back', { defaultValue: 'Back' })}
      actions={
        post ? (
          <Button
            appearance="subtle"
            tone="neutral"
            iconOnly
            leadingIcon={RiEqualizerLine}
            accessibilityLabel={t('settings.threadPreferences.title', {
              defaultValue: 'Thread preferences',
            })}
            onPress={openReplyPreferences}
          />
        ) : undefined
      }
    />
  );
  if (access.failed) {
    return (
      <EmptyState
        error={{
          title: t('safety.contentUnavailable'),
          message: t('safety.retryDescription'),
          onRetry: access.retry,
        }}
      />
    );
  }
  if (!access.allowed) return <FeedSkeleton />;
  if (!loading && (error || !post)) {
    return (
      <Screen scroll="auto" header={header}>
        <SEO
          title={t('seo.post.notFound')}
          description={t('seo.post.notFoundDescription')}
          robots="noindex,nofollow"
        />
        <View className="flex-1 items-center justify-center px-8">
          <RiAlertLine size="3xl" fill={theme.colors.error} />
          <Text className="text-xl font-semibold mt-4 mb-2 text-foreground">Post Not Found</Text>
          <Text className="text-base text-center leading-[22px] mb-6 text-muted-foreground">
            {error || "The post you're looking for doesn't exist or has been deleted."}
          </Text>
          <Button size="lg" onPress={handleBack}>
            Go Back
          </Button>
        </View>
      </Screen>
    );
  }
  return (
    <Screen
      scroll="auto"
      header={header}
      testID="post-screen"
      bottomBar={
        user && postAcceptsReplies(post) ? (
          <PageFooter scrim="auto">
            <FeedHeader
              showComposeButton
              onComposePress={handleOpenReply}
              promptText={t('compose.replyPlaceholder', { defaultValue: 'Post your reply' })}
            />
          </PageFooter>
        ) : undefined
      }
    >
      <SEO
        title={postTitle}
        description={postDescription}
        image={postImage}
        type="article"
        ready={Boolean(post)}
        robots={authoritativeSEO?.robots || 'noindex,nofollow'}
        jsonLd={authoritativeSEO?.jsonLd}
        author={postAuthor}
        publishedTime={post && 'metadata' in post ? post.metadata?.createdAt : undefined}
        modifiedTime={post && 'metadata' in post ? post.metadata?.updatedAt : undefined}
      />
      {loading && !post ? (
        <FeedSkeleton />
      ) : (
        <Feed
          type={'replies' as FeedType}
          filters={feedFilters}
          reloadKey={repliesReloadKey}
          listHeaderComponent={listHeader}
          hideHeader
          threaded={treeView}
          threadPostId={repliesQueryTargetId}
          contentContainerStyle={feedContentStyle}
        />
      )}
    </Screen>
  );
}
