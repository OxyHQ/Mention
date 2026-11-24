import { MAX_POST_DOCUMENTS } from '@mention/shared-types/post';
import { extractUrls } from '@/utils/extractUrls';
import { ownProfileLinkHandle } from '@/utils/ownProfileLinks';
import React, { useCallback, useMemo, useState, lazy, Suspense } from 'react';
import { View, Text as RNText, TouchableOpacity, type GestureResponderEvent } from 'react-native';
import { Link, useRouter, type Href } from '@/lib/navigation/router';
import type { TFunction } from 'i18next';
import type { AccessibilityActionEvent } from 'react-native';
import type {
  PostAttachmentDescriptor,
  PostAttachmentBundle,
  PostContent,
  PostEngagementSummary,
  ClarityDocument,
  PostRoomContent,
  PostUser,
} from '@mention/shared-types/post';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import type { HydratedAuthor } from '@mention/shared-types';
import { toReaderText } from '@mention/shared-types/textEntities';
import {
  Action,
  ActionBar,
  ActionGroup,
  Embed,
  HStack,
  Icon,
  Menu,
  Spacer,
  Text,
  VStack,
  defineTokens,
  toElement,
  view,
  type Child,
  type IconComponent,
} from '@oxy.so/bloom-language';
import { tokens } from '@oxy.so/bloom/styles';
import { toast } from '@oxy.so/bloom/toast';
import type { AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { RiHeartFill } from '@oxy.so/bloom/icons/RiHeartFill';
import { RiCornerDownRightLine } from '@oxy.so/bloom/icons/RiCornerDownRightLine';
import { RiPushpinLine } from '@oxy.so/bloom/icons/RiPushpinLine';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiPencilLine } from '@oxy.so/bloom/icons/RiPencilLine';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiBarChartBoxLine } from '@oxy.so/bloom/icons/RiBarChartBoxLine';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { RiTranslate2 } from '@oxy.so/bloom/icons/RiTranslate2';
import { BookmarkFillIcon } from '@oxy.so/bloom/icons/BookmarkFillIcon';
import { BookmarkIcon } from '@oxy.so/bloom/icons/BookmarkIcon';
import { ReplyIcon } from '@oxy.so/bloom/icons/ReplyIcon';
import { LikeFillIcon } from '@oxy.so/bloom/icons/LikeFillIcon';
import { LikeIcon } from '@oxy.so/bloom/icons/LikeIcon';
import { RepostIcon } from '@oxy.so/bloom/icons/RepostIcon';
import { ShareIcon } from '@oxy.so/bloom/icons/ShareIcon';
import { Text as BloomText } from '@oxy.so/bloom/typography';
import { SubtleHover } from '@oxy.so/bloom/subtle-hover';
import { useTranslation } from 'react-i18next';
import { getNormalizedUserHandle } from '@oxy.so/core';

import { usePostSelector } from '../../stores/postsStore';
import { HEADER_CONTENT_GAP, POST_CONTEXT_ROW_HEIGHT } from '../Post/postContextRowLayout';
import { ProfileHoverCard } from '../ProfileHoverCard';
import PostContentText from '../Post/PostContentText';
import PostLaneChip from '../Post/PostLaneChip';
import PostCrosspostRow from '../Post/PostCrosspostRow';
import PostCommunityRow from '../Post/PostCommunityRow';
import ContentWarning from '../Post/ContentWarning';
import { CommunityNoteCard } from '@/components/CommunityNotes/CommunityNoteCard';
import PostCorrectionNotice from '../Post/PostCorrectionNotice';
import PostDetailStats from '../Post/PostDetailStats';
import PostLocation from '../Post/PostLocation';
import PostAttachmentsRow from '../Post/PostAttachmentsRow';
import type { NestedPostRenderer } from '../Post/Attachments/PostAttachmentNested';
import UserName from '../UserName';
import { AccountBadge } from '@/components/AccountBadge';
import { AccountAvatarGroup } from '@/components/ui/AccountAvatarGroup';
import { LiveAvatar } from '@/components/ui/LiveAvatar';
import { usePostInteractions } from './postInteractions';
import { showRepostMenu } from './showRepostMenu';
import { describePostMenu, PostMenuActions } from './LanguagePostMenu';
import type { PostMenuContentProps } from './PostMenuContent';
import { usePostLanguage } from '@/hooks/usePostLanguage';
import { usePostLanguagePicker } from '@/hooks/usePostLanguagePicker';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { useVoteStyle } from '@/hooks/useVoteStyle';
import { presentSheet } from '@/utils/sheet';
import { openPostInsights } from '@/components/Post/postEngagementContext';
import { postLinkCards } from '@/utils/postLinkCards';
import {
  THREAD_LINE_WIDTH,
  THREAD_LINE_BORDER_RADIUS,
  THREAD_LINE_Z_INDEX,
} from '@/components/Compose/composeLayout';
import { POST_ITEM_SPACING, POST_AVATAR_SIZE, REPLY_BRANCH_INDENT } from '@/styles/shared';
import { enterThreadHover, leaveThreadHover } from '@/stores/threadHoverStore';
import { patchPostReader, usePostReader } from '@/stores/readerStateStore';
import { ThreadHoverOverlay } from './ThreadHoverOverlay';
import { mergeKnownIdentity, useKnownIdentitySet } from '@/stores/identityUpdates';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { reportFeedInteraction } from '@/utils/feedTelemetry';
import { formatFullTimestamp } from '@/utils/dateUtils';
import { formatCompactNumber } from '@/utils/formatNumber';
import { displayNameOrHandle } from '@/utils/displayName';
import {
  isPrivateMention,
  postAcceptsReplies,
  reportableReplyPermission,
} from '@/utils/postReplies';
import { resolveReplyContextRow } from '@/utils/replyContextRow';
import { openExternalLink } from '@/utils/openExternalLink';
import { postItemPropsEqual, type PostItemProps } from './postItemProps';

/**
 * The post row written in the Bloom language: the same row as `PostItem`
 * (same tokens, sizes, spacing and colours, the same components where a piece
 * is embedded), drawn by `@oxy.so/bloom-language`. The controller half (every
 * hook, handler and derived value) is `PostItem`'s, line for line; the tree is
 * `PostItem` + `PostHeader` + `PostActions` as language nodes.
 *
 * Embedded as JSX, unchanged: the avatar (live badge, cluster), the name, the
 * account badge, the lane chip, the community and crosspost rows, the content
 * warning, the title, the body text, the correction notice, the location, the
 * unavailable card, the attachments, the community note, the detail stats, the
 * ⋯ menu, the edited and private-mention markers, the hover overlay, the
 * thread lines, every `Link` and hover card, and the article modal.
 */

// Lazy, as in `PostItem`: none of these is drawn until a reader opens it.
const PostArticleModal = lazy(() => import('@/components/Post/PostArticleModal'));
const EngagementList = lazy(() => import('@/components/Post/EngagementList'));
const CollaboratorsList = lazy(() => import('@/components/Post/CollaboratorsList'));

const EMPTY_LINK_PREVIEWS: ClarityDocument[] = [];
const EMPTY_CONTENT: PostContent = {};

/**
 * The row's measurements that Bloom's scales have no rung for, named once.
 * Everything else in the tree is a Bloom token.
 */
const row = defineTokens({
  space: {
    /** Where the body column starts: padding + avatar slot + gap (64). */
    gutter: POST_ITEM_SPACING.AVATAR_OFFSET,
    /** One context row ("Reposted by", "Pinned", "Replying to"). */
    contextRow: POST_CONTEXT_ROW_HEIGHT,
    /** Between a context row's glyph and its text. */
    contextIconGap: 3,
  },
  iconSize: { context: 13, indicator: 14, menu: 18 },
  /** The identity line's leading (`leading-tight` in the class vocabulary). */
  leading: { tight: 1.25 },
});

/** The ⋯ glyph, with the touch room around it. */
const MENU_GLYPH = Icon(RiMoreFill)
  .size(row.iconSize.menu)
  .foreground('muted')
  .padding('horizontal', 'sm')
  .hitSlop('md');

const NAME_STYLE = { container: { flexShrink: 1, minWidth: 0 } } as const;
const SHRINK_STYLE = { minWidth: 0, flexShrink: 1 } as const;
const INDICATOR_STYLE = { flexShrink: 0, alignSelf: 'center' } as const;

// The two vote arrows are adjacent halves of ONE pill, so neither hit region
// may grow toward the other or it swallows the other's taps.
const UPVOTE_HIT_SLOP = { top: 5, bottom: 5, left: 5, right: 0 };
const DOWNVOTE_HIT_SLOP = { top: 5, bottom: 5, left: 0, right: 5 };

/** A link inside the row stops the click there, or the row would navigate too. */
function stopAtLink(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

/** A context row's glyph, hung in the avatar gutter so the text lines up with the name. */
function contextIcon(icon: IconComponent) {
  return Icon(icon)
    .size(row.iconSize.context)
    .foreground('muted')
    .padding('leading', '-lg')
    .padding('trailing', row.space.contextIconGap);
}

function contextText(...runs: (string | undefined)[]) {
  return Text(...runs)
    .font('sm')
    .weight('semibold')
    .foreground('muted')
    .lines(1);
}

/** Keeps the avatar and ⋯ menu level with the name row below `count` context rows. */
function contextOffset(count: number): Child[] {
  return Array.from({ length: count }, (_, i) =>
    Spacer().frame({ height: row.space.contextRow }).id(i),
  );
}

/** The relative time. Its own view: the clock re-renders the label, not the row. */
const TimeLabel = view(function TimeLabel(props: {
  date: string | undefined;
  href: Href | null;
  onPressTime: () => void;
}) {
  const label = useTimeAgo(props.date);
  if (!label) return null;
  const text = Text('·', ' ', label)
    .font('md')
    .leading(row.leading.tight)
    .foreground('muted')
    .noWrap()
    .shrink('never');
  const { href, onPressTime } = props;
  if (!href) return text;
  return Embed((render) => (
    <Link
      href={href}
      push
      asChild
      onPress={(event) => {
        stopAtLink(event);
        onPressTime();
      }}
    >
      {render(text)}
    </Link>
  ));
});

/**
 * The ⋯ button and its menu, presented natively on each platform (the lens
 * menu on Android). Its own view: opening the menu re-renders the button, not
 * the row; the menu's rows are built only while it is open (`PostMenu`).
 */
/**
 * The ⋯ menu: its rows are tagged data, described from the app's bound
 * services (no hook of the menu's own), and `PostMenuActions` resolves a chosen
 * one where the menu is placed. Before the services are bound, the trigger
 * alone.
 */
const PostMenuButton = view(function PostMenuButton({
  label,
  ...menu
}: PostMenuContentProps & { label: string }) {
  const services = usePostInteractions().menuServices();
  const rows = services ? describePostMenu(menu, services) : [];
  return Menu(MENU_GLYPH, ...rows)
    .actions(PostMenuActions(menu))
    .label(label);
});

interface PostActionsProps {
  t: TFunction;
  replies: number;
  boosts: number;
  likes: number;
  downvotes: number;
  saves: number;
  isLiked: boolean;
  isDownvoted: boolean;
  isBoosted: boolean;
  isSaved: boolean;
  onReply: (() => void) | undefined;
  onBoost: () => void;
  onLike: () => boolean;
  onDownvote: () => void;
  onSave: () => void;
  onShare: () => void;
  onSendInAllo: () => void;
  onTranslate: (() => void) | undefined;
  onTranslateLongPress: (() => void) | undefined;
  isTranslated: boolean;
  isTranslating: boolean;
  onInsightsPress: (() => void) | undefined;
}

/**
 * `PostActions` (the post presentation) in the language: Bloom's engagement
 * bar, one action per glyph. Its own view, compared prop by prop, so a row
 * re-render that leaves the bar's inputs alone does not redraw it.
 */
const PostActions = view(function PostActions(props: PostActionsProps) {
  const voteStyle = useVoteStyle();
  const { t } = props;
  const { onTranslate, onTranslateLongPress, onDownvote } = props;
  return ActionBar(
    voteStyle === 'pill'
      ? ActionGroup(
          Action(RiArrowUpSLine, t('postActions.upvote'), {
            rollCount: true,
            hitSlop: UPVOTE_HIT_SLOP,
          })
            .count(props.likes - props.downvotes)
            .active(props.isLiked)
            .onPress(props.onLike),
          Action(RiArrowDownSLine, t('postActions.downvote'), { hitSlop: DOWNVOTE_HIT_SLOP })
            .active(props.isDownvoted)
            .tint('error')
            .onPress(onDownvote),
        )
      : Action(LikeIcon, t('videos.like'), {
          activeIcon: LikeFillIcon,
          pop: true,
          rollCount: true,
        })
          .count(props.likes)
          .active(props.isLiked)
          .tint('error')
          .onPress(props.onLike),
    props.onReply
      ? Action(ReplyIcon, t('common.reply')).count(props.replies).onPress(props.onReply)
      : null,
    Action(RepostIcon, t('post.repostOptions'))
      .count(props.boosts)
      .active(props.isBoosted)
      .tint('success')
      .onPress(props.onBoost),
    Action(RiSendPlaneLine, t('videos.sendInAllo')).onPress(props.onSendInAllo),
    Action(ShareIcon, t('videos.share')).onPress(props.onShare),
  )
    .trailing(
      Action(BookmarkIcon, t('postActions.save'), { activeIcon: BookmarkFillIcon })
        .count(props.saves)
        .active(props.isSaved)
        .onPress(props.onSave),
      onTranslate
        ? Action(
            RiTranslate2,
            t('compose.languages.overwriteConfirm'),
            // The icon's second job (reading the post in another language) hangs
            // off a long press, which no screen reader performs, so the
            // accessibility action carries the same call.
            onTranslateLongPress
              ? {
                  busy: props.isTranslating,
                  accessibilityActions: [
                    { name: 'translateTo', label: t('postActions.readInAnotherLanguage') },
                  ],
                  onAccessibilityAction: (event: AccessibilityActionEvent) => {
                    if (event.nativeEvent.actionName === 'translateTo') onTranslateLongPress();
                  },
                }
              : { busy: props.isTranslating },
          )
            .active(props.isTranslated)
            .onPress(onTranslate)
            .onLongPress(onTranslateLongPress)
        : null,
      props.onInsightsPress
        ? Action(RiBarChartBoxLine, t('postActions.insights')).onPress(props.onInsightsPress)
        : null,
    )
    .countFormat(formatCompactNumber)
    .size('md');
});

/**
 * The row's controller: `PostItem`'s hooks, handlers and derived values, line
 * for line, plus `PostHeader`'s. A hook of its own so the React Compiler
 * compiles it as it compiles `PostItem`: a component that also builds a
 * language tree would not compile, because the compiler must assume each
 * chain call may change what it is handed.
 */
function usePostRowModel({
  post,
  isNested = false,
  onReply,
  repostedBy,
  repostPlacement,
  socialContext,
  isPostDetail: isPostDetailProp = false,
  feedDescriptor,
  sliceKey,
  threadOpenId,
  isThread = false,
  onOpen,
  openPostEngagement = null,
}: PostItemProps) {
  const { t } = useTranslation();
  const router = useRouter();
  // Every command this row can issue — engagement, share, the ⋯ menu, sources,
  // insights, community notes — from ONE app-lifetime controller. Nothing is
  // instantiated per row; each command resolves the post when pressed.
  const interactions = usePostInteractions();
  const postId = post?.id;
  // The article modal is held as "the post it is open FOR", not as a bare
  // boolean: FlashList reuses this component instance for a different post
  // when a cell is recycled, and a modal open for one post must not show up
  // open on whichever post took over the cell.
  const [articleModalFor, setArticleModalFor] = useState<string | undefined>(undefined);
  const isArticleModalVisible = articleModalFor !== undefined && articleModalFor === postId;
  // The reader's answer to this post's content warning belongs to the POST, not
  // to the row (`readerStateStore`): an opened warning stays open when the
  // reader scrolls away and back, and never opens another post's.
  const isContentWarningOpen = usePostReader(postId, (entry) => entry.contentWarningOpen === true);
  const toggleContentWarning = useCallback(() => {
    patchPostReader(postId, (entry) => ({
      ...entry,
      contentWarningOpen: !entry.contentWarningOpen,
    }));
  }, [postId]);
  // Reactive read of the cached post (compiler-safe `useSyncExternalStore`
  // under the hood — never `useMemo` over an out-of-band SQLite read).
  const storePost = usePostSelector(postId ? String(postId) : undefined);
  const viewPost = storePost ?? post;
  const viewPostId = viewPost?.id ? String(viewPost.id) : undefined;

  // Every actor on this row, corrected against any profile edit made in this
  // session.
  //
  // Each of them is a SNAPSHOT of an identity taken when the server hydrated
  // the post, and nothing rewrites those: the feed query's cached pages and
  // the SQLite copy both keep them, and a remount warm-starts from those pages
  // rather than refetching page 1. So a picture changed after a post was
  // fetched stays wrong on that row until something throws the whole cache
  // away — which is why a full reload looked like the only fix.
  // `stores/identityUpdates` is the one authority that knows better, and
  // resolving it HERE covers every post surface at once: a feed row, a post
  // detail, a quote card and a boosted original are all this same component.
  //
  // All THREE actors, not just the author. They sit side by side in one row —
  // `boostedBy` puts the reposter's picture in the same avatar cluster as the
  // author's — so correcting one and not the others is more conspicuous than
  // correcting none: the same person would be drawn twice, differently, in one
  // cluster. Subscribed by id, so an edit to someone else never wakes this row.
  const knownIdentities = useKnownIdentitySet([
    viewPost?.user?.id,
    repostedBy?.id,
    ...(socialContext?.actors.map((actor) => actor.id) ?? []),
    ...(viewPost?.authors?.map((entry) => entry.id) ?? []),
  ]);
  // Read into locals first: the React Compiler memoizes on the values a memo
  // actually reads, and `viewPost?.user` inside the callback reads as
  // `viewPost` — a mismatch with these deps that made it skip this whole
  // component, the hottest one in the app (#1103).
  const viewUser = viewPost?.user;
  const viewAuthors = viewPost?.authors;
  const author = useMemo(
    () => (viewUser ? mergeKnownIdentity(viewUser, knownIdentities.get(viewUser.id)) : undefined),
    [viewUser, knownIdentities],
  );
  const reposter = useMemo(
    () =>
      repostedBy ? mergeKnownIdentity(repostedBy, knownIdentities.get(repostedBy.id)) : undefined,
    [repostedBy, knownIdentities],
  );
  // The collaborative byline: owner plus each accepted collaborator, drawn as
  // the avatar cluster that replaces the solo avatar.
  const bylineAuthors = useMemo(
    () => viewAuthors?.map((entry) => mergeKnownIdentity(entry, knownIdentities.get(entry.id))),
    [viewAuthors, knownIdentities],
  );

  const viewerState = viewPost?.viewerState ?? {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  };

  const metadata = viewPost?.metadata ?? {};
  const content: PostContent = viewPost?.content ?? EMPTY_CONTENT;
  const attachmentsBundle: PostAttachmentBundle = viewPost?.attachments ?? {};
  // Module-level EMPTY fallback: a fresh `[]` each render would give the
  // memoized PostAttachmentsRow a new array identity every time and defeat its
  // React.memo (and that of the row's children).
  const documents: ClarityDocument[] = viewPost?.documents ?? EMPTY_LINK_PREVIEWS;
  const isSensitiveContent = metadata.isSensitive === true;
  // Content warning (federated `summary` / Mastodon CW) surfaced by the backend as
  // `metadata.spoilerText`. Rendered as a visible label above the body — media blur
  // is handled separately via `isSensitiveContent`; this never gates the body text.
  const spoilerText = typeof metadata.spoilerText === 'string' ? metadata.spoilerText.trim() : '';
  // A content warning GATES the post: while closed, the body and every block
  // below the header (media, links, location, sources, the quoted post) stay
  // hidden behind the warning. Opening it is the reader's consent, so the
  // per-item sensitive-media blur does not ask a second time.
  const isContentGated = spoilerText.length > 0 && !isContentWarningOpen;
  // The post's public correction trail. Absent — not zeroed — on a post that
  // has never been corrected, so presence IS the whole condition for the
  // marker. In practice only a channel post carries one: a personal post keeps
  // its 30-minute edit window and leaves no trail.
  const corrections = metadata.corrections;

  const isOwner = viewerState.isOwner ?? false;
  const isLiked = viewerState.isLiked ?? false;
  const isDownvoted = viewerState.isDownvoted ?? false;
  const isBoosted = viewerState.isBoosted ?? false;
  const isSaved = viewerState.isSaved ?? false;

  const articleContent = attachmentsBundle.article ?? null;
  const hasArticle = Boolean(articleContent);

  const eventContent = attachmentsBundle.event ?? content.event ?? null;
  const roomContent: PostRoomContent | null = attachmentsBundle.room ?? content.room ?? null;

  const homiioCase = attachmentsBundle.homiioCase ?? content.homiioCase ?? null;
  const vibbrEvent = attachmentsBundle.vibbrEvent ?? content.vibbrEvent ?? null;
  const podcastContent = attachmentsBundle.podcast ?? content.podcast ?? null;

  const jobContent = attachmentsBundle.job ?? content.job ?? null;

  const pollData = attachmentsBundle.poll ?? content.poll ?? null;
  const pollId = content.pollId ?? null;

  const location = attachmentsBundle.location ?? content.location ?? null;
  const hasValidLocation = Boolean(location?.coordinates && location.coordinates.length >= 2);

  // Stable identity for the media array so the memoized PostAttachmentsRow can
  // skip re-rendering on an unrelated like/save/translate. A bare `?? []` would
  // hand it a fresh array each render and defeat its React.memo. Always an array.
  const mediaItems = useMemo(() => {
    const m = attachmentsBundle.media ?? content.media;
    return Array.isArray(m) ? m : [];
  }, [attachmentsBundle.media, content.media]);

  const nestedPost = useMemo(() => {
    if (!viewPost) return null;
    if (viewPost.boost?.originalPost) return viewPost.boost.originalPost;
    if (viewPost.quotedPost) return viewPost.quotedPost;
    if (viewPost.originalPost) return viewPost.originalPost;
    return null;
  }, [viewPost]);

  // A boost whose original is genuinely gone (deleted/never-imported): the
  // backend marks `boost.unavailable` with a null `originalPost`. A boost has an
  // empty body, so we render a muted "no longer available" placeholder in the
  // embedded-original slot instead of a blank card.
  const boostUnavailable = Boolean(viewPost?.boost?.unavailable);
  const quoteUnavailable = Boolean(viewPost?.quotedPostUnavailable) && !nestedPost;

  const hasSourceLinkCard = extractUrls(content.text ?? '')
    .slice(0, MAX_POST_DOCUMENTS)
    .some((url) => ownProfileLinkHandle(url) === undefined);
  const shouldRenderMediaBlock =
    mediaItems.length > 0 ||
    Boolean(nestedPost) ||
    Boolean(pollData) ||
    Boolean(articleContent) ||
    Boolean(eventContent) ||
    Boolean(roomContent) ||
    Boolean(homiioCase) ||
    Boolean(vibbrEvent) ||
    Boolean(podcastContent) ||
    Boolean(jobContent) ||
    documents.length > 0 ||
    hasSourceLinkCard ||
    hasValidLocation;

  const attachmentDescriptors: PostAttachmentDescriptor[] | undefined = Array.isArray(
    content.attachments,
  )
    ? content.attachments
    : undefined;

  // Avatar source resolution is delegated to Bloom's Avatar (via the
  // app-wide ImageResolver). The backend emits the canonical Oxy `User`
  // shape: `avatar` is EITHER a bare Oxy file id OR an absolute URL — for
  // BOTH local and federated actors alike (both are mirrored into the same
  // Oxy storage, so there's no federation-based distinction to make here).
  // We always pass `variant={MEDIA_VARIANT_AVATAR}` unconditionally: Bloom's
  // Avatar ignores `variant` entirely when `source` turns out to be an
  // already-absolute URL (rendered straight through) and only applies it
  // when resolving a bare Oxy file id, so there's nothing for this
  // component to detect or branch on.
  //
  // A CHANNEL post has no separate signature to paint: a channel is an Oxy
  // account, so it IS the author and its avatar arrives in `user.avatar` like
  // anybody else's.
  const avatarSource = author?.avatar;
  const avatarVariant = MEDIA_VARIANT_AVATAR;

  // No separate avatar prefetch: the row's own <Avatar> requests the same image
  // in the same commit, so a prefetch only added a request and a hook per row.

  // `isDetailMain` = the FOCUSED post itself (detail variant). Only that post is
  // not a link, because it is a link to the page it is already on — every other
  // row on a `/p/` screen (a reply, an ancestor, a thread continuation) IS a link
  // to its own thread. Derived from props alone, deliberately: reading the route
  // here would re-render every mounted row on every navigation, and flipping the
  // row's element type mid-navigation would remount the whole visible feed.
  const isDetailMain = isPostDetailProp && !isNested;
  const isTappable = isNested || !isDetailMain;

  // A thread (multi-post slice) behaves as one unit: every row shares one
  // `sliceKey`, hovering any row highlights them all, and tapping any row opens
  // the thread at its `threadOpenId`. Standalone posts have no slice wiring and
  // keep per-post hover + their own detail target.
  const isThreadUnit = Boolean(isThread && sliceKey);
  // A post can appear in more than one pane. Ownership must be per instance so
  // a late hover-out or unmount cannot clear another pane's active gesture.
  const [hoverOwner] = useState(() => ({}));

  // Where opening this row goes: thread posts open the whole thread at its
  // subject (`threadOpenId`); standalone posts open their own detail. The tap and the time label's
  // link both read it, so the link a crawler follows is the page a tap opens.
  // `null` when the row opens nothing (the detail view's own main post).
  const openPostHref = useMemo<Href | null>(() => {
    if (!isTappable || !viewPostId) return null;
    return `/p/${isThreadUnit && threadOpenId ? threadOpenId : viewPostId}`;
  }, [isTappable, viewPostId, isThreadUnit, threadOpenId]);

  // What opening the post means besides navigating — shared by the row's tap
  // and the time label's link, which navigates by itself.
  const recordOpen = useCallback(() => {
    // Best-effort feed-ranking signal: opening a post from a feed is a
    // strong positive interaction. No-op when not rendered in a feed
    // (feedDescriptor undefined) or for federated previews without an id.
    if (feedDescriptor && viewPostId) {
      reportFeedInteraction(feedDescriptor, viewPostId, 'click');
    }
    onOpen?.();
  }, [feedDescriptor, viewPostId, onOpen]);

  const goToPost = useCallback(
    (event?: GestureResponderEvent) => {
      // A nested item is its OWN tap target: opening it must NOT also trigger the
      // outer post's press. On React Native Web the press bubbles through the DOM,
      // so stop it here. The outer boost row navigates to the boost's own detail;
      // only the inner card navigates to the embedded original.
      if (isNested) {
        event?.stopPropagation?.();
      }
      if (openPostHref) {
        recordOpen();
        router.push(openPostHref);
      }
    },
    [router, openPostHref, isNested, recordOpen],
  );

  // Canonical profile handle for the author. Built from the full actor so a
  // federated actor resolves to `username@domain` (via isFederated + instance)
  // rather than a bare local-part. Display AND navigation both use this single
  // value so they can never diverge. Empty for a degraded/unresolvable author
  // (empty handle) → no `@handle` shown and no tappable link.
  const authorHandle = useMemo(
    () => (author ? (getNormalizedUserHandle(author) ?? undefined) : undefined),
    [author],
  );

  // The avatar and the identity line both open the author's own profile; the
  // identity line is a `Link` there, the avatar a tap.
  // Opening it starts the profile's pinned post and feed from the id this row
  // already holds, instead of after the profile lookup on the other side.
  const authorHref = useMemo(() => profileHrefForUser(author), [author]);
  const authorId = author?.id;
  const prefetchAuthorProfile = useCallback(() => {
    interactions.prefetchProfile(authorId);
  }, [interactions, authorId]);
  const goToAuthorProfile = useCallback(() => {
    if (authorHref) {
      prefetchAuthorProfile();
      router.push(authorHref);
    }
  }, [router, authorHref, prefetchAuthorProfile]);

  // "Reposted by X" row → the BOOSTER's profile.
  // Canonical handle of the BOOSTER, on the same terms as `authorHandle`: it
  // drives the "Reposted by" row's link and its hover preview from one value.
  const reposterHandle = useMemo(() => getNormalizedUserHandle(reposter) ?? undefined, [reposter]);
  const reposterHref = useMemo(() => profileHrefForUser(reposter), [reposter]);
  // The community a federated post was written in ("in !name@instance").
  const community = viewPost?.community;
  const communityHandle = useMemo(
    () => getNormalizedUserHandle(community) ?? undefined,
    [community],
  );
  const communityHref = useMemo(() => profileHrefForUser(community), [community]);

  // Pass the originating feed descriptor as the engagement `source` so the
  // backend can attribute a like/save/boost to the surface it happened on
  // (e.g. a like in the Videos feed = interest in the video, not the author).
  // Undefined outside a feed (post detail / nested) → normal, unattributed write.
  const handleLike = useCallback(() => {
    if (!viewPost || !interactions.requireSession()) return false;
    void interactions.toggleLike(viewPost, feedDescriptor);
    return true;
  }, [interactions, viewPost, feedDescriptor]);
  const handleDownvote = useCallback(() => {
    if (viewPost) void interactions.toggleDownvote(viewPost);
  }, [interactions, viewPost]);
  const handleSave = useCallback(() => {
    if (viewPost) void interactions.toggleSave(viewPost, feedDescriptor);
  }, [interactions, viewPost, feedDescriptor]);
  const handleBoost = useCallback(() => {
    if (!viewPost || !viewPostId) return;
    if (!interactions.requireSession()) return;
    showRepostMenu({
      isBoosted,
      quotesDisabled: Boolean(metadata.quotesDisabled),
      t,
      onRepost: () => {
        void interactions.toggleBoost(viewPost, feedDescriptor);
      },
      onQuote: () => {
        if (interactions.requireSession())
          router.push(`/compose?quotePostId=${encodeURIComponent(viewPostId)}`);
      },
    });
  }, [
    interactions,
    viewPost,
    viewPostId,
    feedDescriptor,
    isBoosted,
    metadata.quotesDisabled,
    t,
    router,
  ]);
  const handleShare = useCallback(() => {
    if (viewPost) interactions.share(viewPost);
  }, [interactions, viewPost]);
  const handleSendInAllo = useCallback(() => {
    if (viewPostId) interactions.sendInAllo(viewPostId);
  }, [interactions, viewPostId]);

  const handleReply = useCallback(() => {
    if (!interactions.requireSession()) return;
    if (onReply) {
      onReply();
      return;
    }
    if (viewPostId) {
      router.push(`/compose?replyToPostId=${viewPostId}`);
    }
  }, [interactions, onReply, router, viewPostId]);

  // Reading this post in another language. The server already resolved ONE body
  // for this viewer, so everything here is the reader deliberately overruling
  // that choice: `displayText` overrides the body, and it is `null` whenever the
  // server's own resolution is what's on screen. There is no standing control
  // for any of it — a multilingual post reads as one post, and the action bar's
  // translate icon is the whole surface.
  const {
    options: languageOptions,
    activeTag: activeLanguageTag,
    displayText: languageDisplayText,
    isTranslating,
    isTranslated,
    canTranslate,
    selectLanguage,
    toggleReaderTranslation,
  } = usePostLanguage(content, viewPostId, metadata.language, isOwner);
  const openLanguagePicker = usePostLanguagePicker(
    languageOptions,
    activeLanguageTag,
    selectLanguage,
  );

  // A federated link post's title opens the link it is about; the rest of the
  // card still opens the post.
  const titleLinkUrl = content.title ? content.linkUrl : undefined;
  const openTitleLink = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (titleLinkUrl) void openExternalLink(titleLinkUrl);
    },
    [titleLinkUrl],
  );

  const openArticleSheet = useCallback(() => {
    if (hasArticle) {
      setArticleModalFor(postId);
    }
  }, [hasArticle, postId]);

  const closeArticleSheet = useCallback(() => {
    setArticleModalFor(undefined);
  }, []);

  // Each shell host opens its supporting panel; standalone posts use the shared sheet.
  const handleInsightsPress = useCallback(() => {
    if (viewPostId) openPostInsights(openPostEngagement, viewPostId, interactions.openInsights);
  }, [openPostEngagement, interactions, viewPostId]);
  const openEngagementList = useCallback(
    (type: 'likes' | 'boosts') => {
      if (!viewPostId) return;
      if (openPostEngagement?.(viewPostId, type)) return;
      void presentSheet(
        (surface) => (
          <Suspense fallback={null}>
            <EngagementList postId={viewPostId} type={type} onClose={() => surface.dismiss()} />
          </Suspense>
        ),
        {
          label:
            type === 'likes'
              ? t('post.likesTitle', { defaultValue: 'Likes' })
              : t('post.boostsTitle', { defaultValue: 'Reposts' }),
          // The list owns its scrolling: no second scroll container around it.
          scrollable: false,
        },
      );
    },
    [viewPostId, t, openPostEngagement],
  );

  // Bound once each so the memoized <PostDetailStats> is not handed a fresh
  // closure on every render of the focused post.
  const openLikesList = useCallback(() => openEngagementList('likes'), [openEngagementList]);
  const openBoostsList = useCallback(() => openEngagementList('boosts'), [openEngagementList]);
  // Quotes are posts, not actors, so they get a feed screen instead of the
  // engagement list the other two counters open.
  const openQuotesList = useCallback(() => {
    if (viewPostId) router.push(`/p/${viewPostId}/quotes`);
  }, [router, viewPostId]);

  // Owner + accepted collaborators, already hydrated on the post. A post is
  // collaborative when it carries more than one author.
  const collaborators = viewPost?.authors;
  const isCollab = (collaborators?.length ?? 0) > 1;

  // Open the author list — the byline shows first names only, so this is where
  // the full @usernames live. Content is already on the post (no fetch).
  //
  // A signed CHANNEL post lands here too, and "Collaborators" is wrong for it:
  // nobody co-authored anything, one account published what one person wrote.
  // `writer` is the role hydration gives only that person, so it is what picks
  // the heading.
  const openCollaboratorsList = useCallback(() => {
    if (!collaborators || collaborators.length <= 1) return;
    const namesWriter = collaborators.some((a) => a.role === 'writer');
    const label = namesWriter
      ? t('collab.writtenByTitle', { defaultValue: 'Published by' })
      : t('collab.collaboratorsTitle', { defaultValue: 'Collaborators' });
    void presentSheet(
      (surface) => (
        <Suspense fallback={null}>
          <CollaboratorsList
            authors={collaborators}
            onClose={() => surface.dismiss()}
            title={label}
          />
        </Suspense>
      ),
      { label, scrollable: false },
    );
  }, [collaborators, t]);

  const roomId = roomContent?.roomId;
  const handleRoomPress = useCallback(() => {
    if (!roomId) return;
    router.push({
      pathname: '/live-rooms/live/[id]',
      params: { id: roomId },
    });
  }, [roomId, router]);

  const communityNote = viewPost?.communityNote;
  const openCommunityNoteAbout = useCallback(() => {
    if (communityNote) interactions.openCommunityNoteAbout(communityNote);
  }, [communityNote, interactions]);

  // Memoize the structured props handed to the memoized children so they keep a
  // stable identity across re-renders. The inline object/array literals these
  // replace were rebuilt every render, defeating the React.memo on
  // PostAttachmentsRow (media/video subtree) and PostActions — so a like/save/
  // translate re-rendered the whole attachment subtree unnecessarily.
  const articleProp = useMemo(
    () =>
      articleContent
        ? {
            title: articleContent.title,
            body: articleContent.body ?? articleContent.excerpt,
            articleId: articleContent.articleId,
          }
        : null,
    [articleContent],
  );

  const eventProp = useMemo(
    () =>
      eventContent
        ? {
            eventId: eventContent.eventId,
            name: eventContent.name,
            date: eventContent.date,
            location: eventContent.location,
            description: eventContent.description,
          }
        : null,
    [eventContent],
  );

  const roomProp = useMemo(
    () =>
      roomContent && roomId
        ? {
            roomId,
            title: roomContent.title,
            status: roomContent.status,
            topic: roomContent.topic,
            host: roomContent.host,
          }
        : null,
    [roomContent, roomId],
  );

  // The cards the attachment row draws for this post, so the body drops a
  // trailing link one of them already shows (`postLinkCards` is the row's own rule).
  const linkCards = useMemo(
    () => postLinkCards(content.text, documents),
    [content.text, documents],
  );

  const engagementSummary: PostEngagementSummary | undefined = viewPost?.engagement;
  const actionsEngagement = useMemo(
    () => ({
      replies: engagementSummary?.replies ?? 0,
      boosts: engagementSummary?.boosts ?? 0,
      likes: engagementSummary?.likes ?? 0,
      downvotes: engagementSummary?.downvotes ?? 0,
      saves: engagementSummary?.saves ?? 0,
      // Undefined on any DTO the detail endpoints did not produce (feed
      // rows, cache seeds) — the stats row simply omits the entry until a
      // detail read fills it in.
      quotes: engagementSummary?.quotes,
      views: engagementSummary?.views ?? null,
    }),
    [
      engagementSummary?.replies,
      engagementSummary?.boosts,
      engagementSummary?.likes,
      engagementSummary?.downvotes,
      engagementSummary?.saves,
      engagementSummary?.quotes,
      engagementSummary?.views,
    ],
  );

  // ── PostHeader's derived values, unchanged ──────────────────────
  const headerAuthorsSource = bylineAuthors && bylineAuthors.length > 0 ? bylineAuthors : undefined;
  const boostedBy = repostPlacement === 'headOnly' ? undefined : reposter;
  const headerAuthors = useMemo(
    () =>
      (headerAuthorsSource ?? []).map((a: HydratedAuthor) => {
        const handle = getNormalizedUserHandle(a) ?? '';
        const isPerson = a.kind === undefined || a.kind === 'personal';
        const wholeName = a.name?.displayName?.trim();
        const firstName = isPerson
          ? a.name?.first?.trim() || wholeName?.split(/\s+/)?.[0] || (handle ? `@${handle}` : '')
          : wholeName || (handle ? `@${handle}` : '');
        return { firstName, handle, href: profileHrefForUser(a) };
      }),
    [headerAuthorsSource],
  );
  const bylineNamesWriter = useMemo(
    () => (headerAuthorsSource ?? []).some((a) => a.role === 'writer'),
    [headerAuthorsSource],
  );
  const clusterMembers = useMemo<PostUser[]>(() => {
    const members: PostUser[] = [...(headerAuthorsSource ?? [])];
    if (!boostedBy) return members;
    const boosterIndex = members.findIndex((member) => member.id === boostedBy.id);
    if (boosterIndex > 0) {
      const [lead] = members.splice(boosterIndex, 1);
      members.unshift(lead);
    } else if (boosterIndex < 0 && members.length === 1) {
      members.push(boostedBy);
    }
    return members;
  }, [headerAuthorsSource, boostedBy]);
  const collabAvatars = useMemo<AvatarGroupItem[]>(
    () =>
      clusterMembers.length > 1
        ? clusterMembers.map((member) => ({
            id: member.id,
            uri: member.avatar,
            kind: member.kind,
            character: member.character,
            color: member.color,
            displayName: displayNameOrHandle(
              member.name?.displayName,
              getNormalizedUserHandle(member) ?? '',
            ),
            username: member.username,
          }))
        : [],
    [clusterMembers],
  );

  return {
    t,
    isArticleModalVisible,
    isContentWarningOpen,
    toggleContentWarning,
    viewPost,
    viewPostId,
    knownIdentities,
    author,
    reposter,
    metadata,
    content,
    documents,
    isSensitiveContent,
    spoilerText,
    isContentGated,
    corrections,
    isOwner,
    isLiked,
    isDownvoted,
    isBoosted,
    isSaved,
    articleContent,
    hasArticle,
    homiioCase,
    vibbrEvent,
    podcastContent,
    jobContent,
    pollData,
    pollId,
    location,
    hasValidLocation,
    mediaItems,
    nestedPost,
    boostUnavailable,
    quoteUnavailable,
    shouldRenderMediaBlock,
    attachmentDescriptors,
    avatarSource,
    avatarVariant,
    isDetailMain,
    isTappable,
    isThreadUnit,
    hoverOwner,
    openPostHref,
    recordOpen,
    goToPost,
    authorHandle,
    authorHref,
    prefetchAuthorProfile,
    goToAuthorProfile,
    reposterHandle,
    reposterHref,
    communityHandle,
    communityHref,
    handleLike,
    handleDownvote,
    handleSave,
    handleBoost,
    handleShare,
    handleSendInAllo,
    handleReply,
    openLanguagePicker,
    titleLinkUrl,
    openTitleLink,
    openArticleSheet,
    closeArticleSheet,
    handleInsightsPress,
    openLikesList,
    openBoostsList,
    openQuotesList,
    isCollab,
    openCollaboratorsList,
    roomId,
    handleRoomPress,
    communityNote,
    openCommunityNoteAbout,
    articleProp,
    eventProp,
    roomProp,
    linkCards,
    engagementSummary,
    actionsEngagement,
    headerAuthors,
    bylineNamesWriter,
    collabAvatars,
    languageDisplayText,
    isTranslating,
    isTranslated,
    canTranslate,
    toggleReaderTranslation,
  };
}

/**
 * The row: `PostItem` + `PostHeader` + `PostActions` as language nodes. Named,
 * so the component carries the name.
 */
function PostRow(props: PostItemProps): Child {
  const {
    isNested = false,
    showPinned = false,
    nestingDepth = 0,
    isThreadParent = false,
    isThreadChild = false,
    isThreadLastChild = false,
    replyBranch = false,
    attachedBelow = false,
    hideSeparator = false,
    repostPlacement,
    socialContext,
    threadPosition,
    feedDescriptor,
    sliceKey,
  } = props;
  const {
    t,
    isArticleModalVisible,
    isContentWarningOpen,
    toggleContentWarning,
    viewPost,
    viewPostId,
    knownIdentities,
    author,
    reposter,
    metadata,
    content,
    documents,
    isSensitiveContent,
    spoilerText,
    isContentGated,
    corrections,
    isOwner,
    isLiked,
    isDownvoted,
    isBoosted,
    isSaved,
    articleContent,
    hasArticle,
    homiioCase,
    vibbrEvent,
    podcastContent,
    jobContent,
    pollData,
    pollId,
    location,
    hasValidLocation,
    mediaItems,
    nestedPost,
    boostUnavailable,
    quoteUnavailable,
    shouldRenderMediaBlock,
    attachmentDescriptors,
    avatarSource,
    avatarVariant,
    isDetailMain,
    isTappable,
    isThreadUnit,
    hoverOwner,
    openPostHref,
    recordOpen,
    goToPost,
    authorHandle,
    authorHref,
    prefetchAuthorProfile,
    goToAuthorProfile,
    reposterHandle,
    reposterHref,
    communityHandle,
    communityHref,
    handleLike,
    handleDownvote,
    handleSave,
    handleBoost,
    handleShare,
    handleSendInAllo,
    handleReply,
    openLanguagePicker,
    titleLinkUrl,
    openTitleLink,
    openArticleSheet,
    closeArticleSheet,
    handleInsightsPress,
    openLikesList,
    openBoostsList,
    openQuotesList,
    isCollab,
    openCollaboratorsList,
    roomId,
    handleRoomPress,
    communityNote,
    openCommunityNoteAbout,
    articleProp,
    eventProp,
    roomProp,
    linkCards,
    engagementSummary,
    actionsEngagement,
    headerAuthors,
    bylineNamesWriter,
    collabAvatars,
    languageDisplayText,
    isTranslating,
    isTranslated,
    canTranslate,
    toggleReaderTranslation,
  } = usePostRowModel(props);

  if (!viewPost || !author) {
    return null;
  }

  // HPAD/VPAD/SECTION_GAP are `md` (12) and HEADER_CONTENT_GAP is `xs` (4);
  // the body column starts at the gutter (64) on a feed row.
  const { HPAD, VPAD } = POST_ITEM_SPACING;
  const contentInset = isNested || isDetailMain ? 'md' : row.space.gutter;

  const fullTimestamp = isDetailMain ? formatFullTimestamp(metadata.createdAt ?? '') : '';

  const hasBelowHeaderBlocks = Boolean(
    (hasValidLocation && location) ||
      shouldRenderMediaBlock ||
      boostUnavailable ||
      quoteUnavailable ||
      !isNested,
  );
  // Text posts keep the section rhythm; a post with no text hugs its first block.
  const headerToBlocksGap = content.text || content.title ? 'md' : 'xs';

  const replyContextRow = resolveReplyContextRow({
    post: viewPost,
    isNested,
    parentShownAbove: isThreadChild,
  });

  const postAuthor = displayNameOrHandle(
    author.name?.displayName,
    authorHandle ? `@${authorHandle}` : '',
  );
  const summaryText = content.title ?? toReaderText(content.text ?? '');
  const postTextSummary = summaryText
    ? summaryText.length > 80
      ? `${summaryText.substring(0, 80)}...`
      : summaryText
    : '';
  const postAccessibilityLabel = postTextSummary
    ? `${postAuthor}: ${postTextSummary}`
    : `Post by ${postAuthor}`;

  // ── Context rows (Reposted by / liked by / Pinned / community / crosspost / Replying to)
  const contextRows: Child[] = [];
  if (reposter && repostPlacement !== 'shownAbove') {
    const repostedByText = contextText(
      t('post.repostedBy', { defaultValue: 'Reposted by' }),
      ' ',
      displayNameOrHandle(reposter.name?.displayName, reposterHandle ? `@${reposterHandle}` : ''),
    );
    const repostRow = HStack(
      contextIcon(RiRepeat2Line),
      reposterHref
        ? Embed((render) => (
            // A link to the BOOSTER's profile; the row beneath opens the original.
            <Link href={reposterHref} push asChild onPress={stopAtLink}>
              {render(repostedByText)}
            </Link>
          ))
        : repostedByText,
    )
      .align('center')
      .frame({ height: row.space.contextRow });
    contextRows.push(
      Embed((render) => (
        <ProfileHoverCard username={reposterHandle}>{render(repostRow)}</ProfileHoverCard>
      )).id('reposted'),
    );
  }
  if (
    !isNested &&
    socialContext &&
    socialContext.postId === viewPostId &&
    socialContext.total > 0 &&
    !(
      socialContext.type === 'boostedBy' &&
      reposter &&
      socialContext.actors.every((actor) => actor.id === reposter.id)
    )
  ) {
    const names = socialContext.actors
      .slice(0, 2)
      .map((actor) => {
        const identity = mergeKnownIdentity(actor, knownIdentities.get(actor.id));
        return displayNameOrHandle(
          identity.name?.displayName,
          getNormalizedUserHandle(identity) ?? '',
        );
      })
      .filter(Boolean);
    const isBoostSocialContext = socialContext.type === 'boostedBy';
    const label = isBoostSocialContext
      ? `${t('post.repostedBy', { defaultValue: 'Reposted by' })} ${names.join(', ')}`
      : names.length < 2 || socialContext.total === 1
        ? t('post.likedBy.one', { name1: names[0], defaultValue: 'Liked by {{name1}}' })
        : socialContext.total === 2
          ? t('post.likedBy.two', {
              name1: names[0],
              name2: names[1],
              defaultValue: 'Liked by {{name1}} and {{name2}}',
            })
          : t('post.likedBy.many', {
              name1: names[0],
              name2: names[1],
              count: socialContext.total - 2,
              defaultValue: 'Liked by {{name1}}, {{name2}} and {{count}} others',
            });
    if (names.length > 0)
      contextRows.push(
        HStack(
          contextIcon(isBoostSocialContext ? RiRepeat2Line : RiHeartFill),
          contextText(label).shrink('normal'),
        )
          .align('center')
          .frame({ height: row.space.contextRow })
          .role('button')
          .label(label)
          .onPress((event) => {
            event.stopPropagation();
            if (isBoostSocialContext) openBoostsList();
            else openLikesList();
          })
          .id('social-reason'),
      );
  }
  if (showPinned) {
    contextRows.push(
      HStack(contextIcon(RiPushpinLine), contextText(t('post.pinned', { defaultValue: 'Pinned' })))
        .align('center')
        .frame({ height: row.space.contextRow })
        .id('pinned'),
    );
  }
  // A reply belongs to its thread's community, so only a post that starts one says it.
  if (communityHandle && !viewPost.replyContext) {
    contextRows.push(
      Embed(<PostCommunityRow handle={communityHandle} href={communityHref} />).id('community'),
    );
  }
  if (viewPost.crosspost) {
    contextRows.push(Embed(<PostCrosspostRow crosspost={viewPost.crosspost} />).id('crosspost'));
  }
  if (replyContextRow) {
    const replyRow = HStack(
      contextIcon(RiCornerDownRightLine),
      contextText(
        replyContextRow.label
          ? `${t('post.replyingTo', { defaultValue: 'Replying to' })} @${replyContextRow.label}`
          : t('post.replyingToUnknown', { defaultValue: 'Replying to a post' }),
      ),
    )
      .align('center')
      .frame({ height: row.space.contextRow });
    const replyHandle = replyContextRow.authorHandle;
    contextRows.push(
      (replyHandle
        ? Embed((render) => (
            <ProfileHoverCard username={replyHandle}>{render(replyRow)}</ProfileHoverCard>
          ))
        : replyRow
      ).id('reply'),
    );
  }

  // The avatar and the ⋯ menu stand level with the name row, below the context rows.
  const contextCount = contextRows.length;
  const headerTopOffset = contextCount * (POST_CONTEXT_ROW_HEIGHT + HEADER_CONTENT_GAP);

  // ── PostHeader ──────────────────────────────────────────────────
  const user = {
    displayName: author.name?.displayName,
    handle: authorHandle || '',
    verified: author.verified,
    isFederated: author.isFederated,
    kind: author.kind,
    character: author.character,
    color: author.color,
    instance: author.instance,
  };
  const compact = isNested;
  const detail = isDetailMain;
  const avatarSize = isNested ? 20 : POST_AVATAR_SIZE;
  const isCollabByline = headerAuthors.length > 1;
  const hasDisplayName = !isCollabByline && !!user.displayName?.trim();
  const onPressCollaborators = isCollab ? openCollaboratorsList : undefined;

  const avatar =
    collabAvatars.length > 1
      ? Embed(
          <ProfileHoverCard username={isCollabByline ? undefined : user.handle}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={
                isCollabByline
                  ? t('collab.viewCollaborators', { defaultValue: 'View collaborators' })
                  : displayNameOrHandle(user.displayName, user.handle ? `@${user.handle}` : '')
              }
              disabled={isCollabByline ? !onPressCollaborators : false}
              onPress={isCollabByline ? onPressCollaborators : goToAuthorProfile}
            >
              <AccountAvatarGroup
                layout="cluster"
                items={collabAvatars}
                size={avatarSize}
                variant={avatarVariant}
                max={20}
              />
            </TouchableOpacity>
          </ProfileHoverCard>,
        )
      : Embed(
          <ProfileHoverCard username={user.handle}>
            <LiveAvatar
              account={user}
              userId={author.id || undefined}
              source={avatarSource}
              variant={avatarVariant}
              size={avatarSize}
              onPress={goToAuthorProfile}
            />
          </ProfileHoverCard>,
        );

  const menuButton = PostMenuButton({
    label: t('postActions.title', { defaultValue: 'Post options' }),
    post: viewPost,
    isPostDetail: isDetailMain,
    source: feedDescriptor,
    onOpenArticle: openArticleSheet,
    onInsights: handleInsightsPress,
  });

  const identityName = Embed(
    <UserName
      name={hasDisplayName ? user.displayName : user.handle ? `@${user.handle}` : undefined}
      verified={user.verified}
      href={authorHref}
      onPress={prefetchAuthorProfile}
      asHeading={isDetailMain}
      style={NAME_STYLE}
    />,
  );
  const identityHandle =
    hasDisplayName && user.handle
      ? Text(`${detail ? '' : ' '}@${user.handle}`)
          .font('md')
          .leading(row.leading.tight)
          .foreground('muted')
          .shrink('first')
          .frame({ minWidth: 'none' })
          .lines(1)
      : null;
  const identityBadge = Embed(
    <AccountBadge
      isFederated={user.isFederated}
      kind={user.kind}
      size={13}
      containerClassName="self-center ml-1"
    />,
  );

  const identity = isCollabByline
    ? Embed(
        <View className="flex-row items-end flex-shrink" style={{ minWidth: 0 }}>
          <RNText
            className="text-foreground text-[15px] font-semibold leading-tight"
            style={SHRINK_STYLE}
            numberOfLines={2}
          >
            {headerAuthors.map((a, i) => {
              const isLast = i === headerAuthors.length - 1;
              const separator =
                i === 0
                  ? ''
                  : isLast
                    ? bylineNamesWriter
                      ? t('collab.by', { defaultValue: ' by ' })
                      : t('collab.and', { defaultValue: ' and ' })
                    : ', ';
              return (
                <React.Fragment key={`${a.handle || 'author'}-${i}`}>
                  {separator}
                  {a.href ? (
                    <Link href={a.href} push onPress={stopAtLink} accessibilityLabel={a.firstName}>
                      {a.firstName}
                    </Link>
                  ) : (
                    <RNText>{a.firstName}</RNText>
                  )}
                </React.Fragment>
              );
            })}
          </RNText>
        </View>,
      )
    : // The whole identity line is one hover target.
      Embed((render) => (
        <ProfileHoverCard username={user.handle} style={SHRINK_STYLE}>
          {render(
            detail
              ? VStack(HStack(identityName, identityBadge).align('center'), identityHandle)
                  .align('start')
                  .frame({ minWidth: 'none' })
              : HStack(identityName, identityHandle, identityBadge)
                  .align('end')
                  .shrink('normal')
                  .frame({ minWidth: 'none' }),
          )}
        </ProfileHoverCard>
      ));

  const indicator = (icon: IconComponent, label: string, message: string, testID?: string) =>
    Embed((render) => (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={tokens.hitSlop.md}
        style={INDICATOR_STYLE}
        onPress={() => toast(message)}
        testID={testID}
      >
        {render(Icon(icon).size(row.iconSize.indicator).foreground('muted'))}
      </TouchableOpacity>
    ));

  const identityLine = HStack(
    compact ? avatar : null,
    identity,
    detail
      ? null
      : TimeLabel({ date: metadata.createdAt, href: openPostHref, onPressTime: recordOpen }),
    metadata.isEdited
      ? indicator(
          RiPencilLine,
          t('post.editedIndicator', { defaultValue: 'Edited' }),
          t('post.editedToast', { defaultValue: 'This post was edited' }),
        )
      : null,
    isPrivateMention(viewPost)
      ? indicator(
          RiLockLine,
          t('privateMentions.badge', { defaultValue: 'Private mention' }),
          t('privateMentions.onlyMentioned', {
            defaultValue: 'Only visible to the people mentioned',
          }),
          'post-private-mention-badge',
        )
      : null,
    // The lane chip, after the time; not on a boost or a collaborative byline.
    viewPost.lane && !viewPost.boost && !isCollab
      ? Embed(
          <PostLaneChip
            lane={viewPost.lane}
            authorHandle={authorHandle || ''}
            feedDescriptor={feedDescriptor}
          />,
        )
      : null,
    viewPost.boost && !isNested
      ? Icon(RiRepeat2Line)
          .size(row.iconSize.indicator)
          .foreground('muted')
          .role('image')
          .label('Reposted')
      : null,
    compact ? Spacer() : null,
    compact ? menuButton : null,
  )
    .align(compact ? 'center' : 'end')
    .spacing('sm');

  // ── The post body ───────────────────────────────────────────────
  const hasPostBody = Boolean(
    spoilerText ||
      (!isContentGated &&
        (content.title || content.text || threadPosition || (corrections && viewPostId))),
  );
  const postBody: Child[] = [
    spoilerText
      ? Embed(
          <ContentWarning
            text={spoilerText}
            revealed={isContentWarningOpen}
            onToggle={toggleContentWarning}
          />,
        )
      : null,
    content.title && !isContentGated
      ? Embed(
          <BloomText
            variant="headline-semibold"
            accessibilityRole={titleLinkUrl ? 'link' : undefined}
            onPress={titleLinkUrl ? openTitleLink : undefined}
          >
            {content.title}
          </BloomText>,
        )
      : null,
    (content.text || threadPosition) && !isContentGated
      ? Embed(
          <PostContentText
            content={content}
            postId={viewPostId}
            detail={isDetailMain}
            previewChars={isDetailMain ? Infinity : undefined}
            overrideText={languageDisplayText}
            linkCards={linkCards}
            trailingContent={
              threadPosition && !isNested ? (
                <RNText>
                  {' '}
                  <RNText
                    className="bg-surface text-muted-foreground rounded-full text-[11px]"
                    accessibilityLabel={t('post.threadPosition', {
                      defaultValue: 'Post {{index}} of {{total}} in thread',
                      index: threadPosition.index,
                      total: threadPosition.total,
                    })}
                  >
                    {` ${threadPosition.index}/${threadPosition.total} `}
                  </RNText>
                </RNText>
              ) : undefined
            }
          />,
        )
      : null,
    corrections && viewPostId && !isContentGated
      ? Embed(<PostCorrectionNotice postId={viewPostId} count={corrections.count} />)
      : null,
  ];

  const hasContext = contextCount > 0;
  const avatarColumn = hasContext
    ? VStack(contextOffset(contextCount), avatar).spacing('xs')
    : avatar;
  const menuColumn = hasContext
    ? VStack(contextOffset(contextCount), menuButton).spacing('xs')
    : menuButton;
  // The avatar's 12px gap is the content column's leading padding: one view fewer than a wrapper.
  const contentStack = VStack(
    hasContext ? contextRows : null,
    identityLine,
    detail ? null : VStack(...postBody),
  );
  const contentColumn = (compact ? contentStack : contentStack.padding('leading', 'md'))
    .grow()
    .frame({ minWidth: 'none' })
    .spacing('xs');
  const header = HStack(compact ? null : avatarColumn, contentColumn, compact ? null : menuColumn)
    .align('start')
    .justify('between')
    .padding('horizontal', 'md');

  // ── Below the header ────────────────────────────────────────────
  const inset = (child: Child) =>
    VStack(child).padding('leading', contentInset).padding('trailing', 'md');

  const blocks =
    hasBelowHeaderBlocks && !isContentGated
      ? VStack(
          hasValidLocation && location
            ? inset(Embed(<PostLocation location={location} paddingHorizontal={0} />))
            : null,
          boostUnavailable || quoteUnavailable
            ? inset(
                Embed(
                  <View className="border-border rounded-2xl border px-3 py-3">
                    <RNText className="text-muted-foreground text-[14px]">
                      {quoteUnavailable
                        ? t('post.quoteUnavailable', {
                            defaultValue: 'This quoted post is unavailable',
                          })
                        : t('post.boostUnavailable', {
                            defaultValue: 'This post is no longer available',
                          })}
                    </RNText>
                  </View>,
                ),
              )
            : null,
          shouldRenderMediaBlock
            ? Embed(
                <PostAttachmentsRow
                  sensitive={isSensitiveContent && !spoilerText}
                  media={mediaItems}
                  attachments={attachmentDescriptors}
                  nestedPost={nestedPost ?? null}
                  renderNestedPost={renderNestedPost}
                  leftOffset={isNested || isDetailMain ? HPAD : POST_ITEM_SPACING.AVATAR_OFFSET}
                  pollData={pollData}
                  pollId={pollId ? String(pollId) : undefined}
                  nestingDepth={nestingDepth}
                  postId={viewPostId}
                  article={articleProp}
                  onArticlePress={hasArticle ? openArticleSheet : undefined}
                  event={eventProp}
                  room={roomProp}
                  onRoomPress={roomId ? handleRoomPress : undefined}
                  homiioCase={homiioCase}
                  vibbrEvent={vibbrEvent}
                  podcast={podcastContent}
                  job={jobContent}
                  location={location}
                  text={content.text}
                  documents={documents}
                  documentsPending={viewPost.documentsPending === true}
                />,
              )
            : null,
          // Context ABOUT the post, never part of it: below the author's content, above the actions.
          communityNote?.status === 'shown' && !isNested
            ? inset(
                Embed(
                  <CommunityNoteCard note={communityNote} onPressAbout={openCommunityNoteAbout} />,
                ),
              )
            : null,
          isNested
            ? null
            : inset(
                PostActions({
                  t,
                  replies: actionsEngagement.replies,
                  boosts: actionsEngagement.boosts,
                  likes: actionsEngagement.likes,
                  downvotes: actionsEngagement.downvotes,
                  saves: actionsEngagement.saves,
                  isLiked,
                  isDownvoted,
                  isBoosted,
                  isSaved,
                  // Derived from the POST, so an affordance that would be refused is absent.
                  onReply: postAcceptsReplies(viewPost) ? handleReply : undefined,
                  onBoost: handleBoost,
                  onLike: handleLike,
                  onDownvote: handleDownvote,
                  onSave: handleSave,
                  onShare: handleShare,
                  onSendInAllo: handleSendInAllo,
                  onTranslate: canTranslate ? toggleReaderTranslation : undefined,
                  onTranslateLongPress: openLanguagePicker,
                  isTranslated,
                  isTranslating,
                  onInsightsPress: isOwner && isDetailMain ? handleInsightsPress : undefined,
                }),
              ),
          isDetailMain
            ? Embed(
                <PostDetailStats
                  timestampLabel={fullTimestamp}
                  likes={engagementSummary?.likes}
                  boosts={engagementSummary?.boosts}
                  quotes={metadata.quotesDisabled ? null : engagementSummary?.quotes}
                  saves={engagementSummary?.saves}
                  replyPermission={reportableReplyPermission(viewPost)}
                  quotesDisabled={metadata.quotesDisabled}
                  postId={viewPostId}
                  onLikesPress={openLikesList}
                  onBoostsPress={openBoostsList}
                  onQuotesPress={openQuotesList}
                />,
              )
            : null,
        ).spacing('md')
      : null;

  // ── Thread lines: decoration measured from the avatar, drawn as before ──
  const THREAD_LINE_LEFT = HPAD + POST_AVATAR_SIZE / 2 - THREAD_LINE_WIDTH / 2;
  const threadChildLine =
    isThreadChild && !isNested
      ? Embed(
          // Above the avatar, from the previous post's bottom to just above the offset avatar.
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: THREAD_LINE_LEFT,
              width: THREAD_LINE_WIDTH,
              height: headerTopOffset + 4,
              borderRadius: THREAD_LINE_BORDER_RADIUS,
              zIndex: THREAD_LINE_Z_INDEX,
            }}
            className="bg-border"
          />,
        )
      : null;
  const threadParentLine =
    isThreadParent && !isNested && !isDetailMain
      ? Embed(
          // Below the avatar, to the next post's top.
          <View
            style={{
              position: 'absolute',
              top: (isThreadChild ? 4 : VPAD) + POST_AVATAR_SIZE + 4 + headerTopOffset,
              left: THREAD_LINE_LEFT,
              width: THREAD_LINE_WIDTH,
              bottom: 0,
              borderRadius: THREAD_LINE_BORDER_RADIUS,
              zIndex: THREAD_LINE_Z_INDEX,
            }}
            className="bg-border"
          />,
        )
      : null;
  const replyBranchElbow =
    replyBranch && !isNested
      ? Embed(
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: THREAD_LINE_LEFT - REPLY_BRANCH_INDENT,
              top: 0,
              width: REPLY_BRANCH_INDENT - POST_AVATAR_SIZE / 2 - 3,
              height: VPAD + headerTopOffset + POST_AVATAR_SIZE / 2,
              borderLeftWidth: THREAD_LINE_WIDTH,
              borderBottomWidth: THREAD_LINE_WIDTH,
              borderBottomLeftRadius: 8,
            }}
            className="border-border"
          />,
        )
      : null;

  // ── The row ─────────────────────────────────────────────────────
  // A thread row or one with something attached below closes onto it: no
  // bottom padding and no separator. A reply-branch row drops the separator.
  const closedBelow = isThreadParent || (isThreadChild && !isThreadLastChild) || attachedBelow;
  let rowView = VStack(
    isThreadUnit && sliceKey
      ? Embed(<ThreadHoverOverlay sliceKey={sliceKey} owner={hoverOwner} visible={isTappable} />)
      : isTappable
        ? Embed(<SubtleHover />)
        : null,
    threadChildLine,
    threadParentLine,
    replyBranchElbow,
    VStack(
      header,
      isDetailMain && hasPostBody
        ? VStack(...postBody)
            .padding('horizontal', 'md')
            .spacing('xs')
        : null,
      blocks,
    ).spacing(headerToBlocksGap),
  );
  if (isNested) {
    rowView = rowView.padding('vertical', 'md').border('border', 'hairline').corner('lg');
  } else {
    rowView = rowView
      .padding('top', isThreadChild ? 'xs' : 'md')
      .padding('bottom', closedBelow ? 'none' : 'md');
    if (!closedBelow && !hideSeparator) rowView = rowView.border('border', 'hairline', 'bottom');
  }
  rowView = rowView
    .hoverGroup()
    .label(postAccessibilityLabel)
    // The row is one element type on every route; only the handler comes and goes.
    .onPress(isTappable ? goToPost : undefined);
  if (isThreadUnit) {
    rowView = rowView.onHover(
      () => {
        if (sliceKey) enterThreadHover(sliceKey, hoverOwner);
      },
      () => {
        if (sliceKey) leaveThreadHover(hoverOwner, sliceKey);
      },
    );
  }

  return [
    rowView,
    articleContent
      ? Embed(
          <Suspense fallback={null}>
            <PostArticleModal
              visible={isArticleModalVisible}
              onClose={closeArticleSheet}
              articleId={articleContent.articleId}
              title={articleContent.title}
              body={articleContent.body}
            />
          </Suspense>,
        )
      : null,
  ];
}

const PostRowView = view(PostRow);

function LanguagePostItemContent(props: PostItemProps) {
  return toElement(PostRowView(props));
}

/** `PostItem`'s comparator, plus the separator flag the language row reads by name. */
function languageRowPropsEqual(prev: PostItemProps, next: PostItemProps): boolean {
  return prev.hideSeparator === next.hideSeparator && postItemPropsEqual(prev, next);
}

const LanguagePostItem = React.memo(LanguagePostItemContent, languageRowPropsEqual);

// Quotes render through the same row, as in `PostItem`.
const renderNestedPost: NestedPostRenderer = (nested, depth, openPostEngagement) => (
  <LanguagePostItem
    post={nested}
    isNested
    nestingDepth={depth}
    openPostEngagement={openPostEngagement}
  />
);

export default LanguagePostItem;
