/** Assembling the served DTO of one post from its raw record and the batched maps. */
import { sanitizePodcast } from '../../../utils/podcastReference';
import { sanitizeHomiioCase, homiioCaseFromText } from '@mention/shared-types/homiio';
import { sanitizeVibbrEvent, vibbrEventFromText } from '@mention/shared-types/vibbr';
import {
  type HydratedPost,
  type HydratedPostSummary,
  type HydratedRepostContext,
  type HydratedAuthor,
  type PostUser,
  type PostAttachmentBundle,
  type PostEngagementSummary,
  type PostPermissions,
  type PostReplyContext,
  type PostViewerState,
  PostVisibility,
  type PostAuthorshipEntry,
} from '@mention/shared-types';
import type { CrosspostProvenance, LaneSummary } from '@mention/shared-types';
import { networkLabel, type CrosspostVariantRow } from '../PostEquivalenceService';
import type { PostImportHydration } from '../../../db/imports/postImportRepository';
import { disclosesWriters } from '../../accounts/channelWriterDisclosure';
import { resolveMediaItems } from '../../../utils/mediaResolver';
import { readPersistedMediaFields } from '../../media/MediaMetadataService';
import { DEFAULT_PRIVACY } from '../../engagement/engagementCountPrivacy';
import {
  getHeaderAuthorshipEntries,
  getViewerEntry,
  normalizeAuthorship,
} from '../../../utils/postAuthorship';
import { canManagePostWithoutLookup } from '../access/postManagementAccess';
import { degradedActorSummary } from '../../../utils/degradedActorSummary';
import { readerVariants, resolveVariant, type ResolvedVariant } from '../postVariants';
import { quotedPostUrls } from '../../../utils/clarityDocuments';
import type { PostContentVariant, StoredPostContent } from '@mention/shared-types';
import type { ExtendedViewerContext, RawPost, ViewerContext } from './types';
import type { ClarityDocumentMap } from './contentMaps';
import { extractReferenceIds, extractRepostOriginalId, resolveId } from './graph';
import { resolveMentionText } from './mentions';
import { isFallbackUserSummary } from './userSummaries';

/**
 * The `crosspost` field for one post, or `undefined` when it has none.
 *
 * A cluster of fewer than two members is treated as no provenance rather than as
 * a one-item list: one network is not provenance, it is simply where the post
 * is. That state is transient — `reevaluateCluster` dissolves a cluster the
 * moment it drops below two — but hydration can read a page mid-repair, and a
 * card reading `Instagram` on its own would say nothing while looking like it
 * meant something. The same holds for a cluster whose members all sit on ONE
 * network — an import collapsed under the federated copy of its source post
 * (`collapseImportedCopies`): `Mastodon · Mastodon` is not provenance either.
 */
function buildCrosspostProvenance(
  variants: CrosspostVariantRow[] | undefined,
): { crosspost: CrosspostProvenance } | undefined {
  if (!variants || variants.length < 2) return undefined;
  if (new Set(variants.map((variant) => variant.networkDomain)).size < 2) return undefined;
  return {
    crosspost: {
      variants: variants.map((variant) => ({
        network: variant.networkDomain,
        label: networkLabel(variant.networkDomain),
        postId: variant.postId,
        rendered: variant.preferred,
      })),
    },
  };
}

export async function buildPostSummary(params: {
  post: RawPost;
  viewerContext: ViewerContext;
  pollMap: Map<string, Record<string, unknown>>;
  userMap: Map<string, PostUser>;
  mentionCache: Map<string, PostUser>;
  linkPreviewMap: ClarityDocumentMap;
  authorPrivacyMap: Map<string, typeof DEFAULT_PRIVACY>;
  recentReplierMap?: Map<string, string[]>;
  orphanAuthorMap: Map<string, PostUser>;
  resolvedMap: Map<string, ResolvedVariant>;
  /** Undefined unless the caller passed `includeQuoteCounts` — see {@link HydrationOptions}. */
  quoteCountMap: Map<string, number> | undefined;
  /** Reply post id → its parent's author id, for the posts whose parent this viewer may read. */
  replyParentAuthorIdByPostId: Map<string, string>;
  /** Replies to their OWN author's post — self-thread continuations, which carry no reply context. */
  selfContinuationPostIds: Set<string>;
  /** The author's lanes, keyed by lane id — the `› Lane name` chip in the name row. */
  laneMap: Map<string, LaneSummary>;
  crosspostMap: Map<string, CrosspostVariantRow[]>;
  /** Import provenance of the posts in this page that were imported — see {@link buildImportMap}. */
  importMap: Map<string, PostImportHydration>;
  /** Channel accounts in this page whose `signPosts` is on — see {@link buildSigningChannelIds}. */
  signingChannelIds: Set<string>;
}): Promise<HydratedPostSummary | null> {
  const {
    post,
    viewerContext,
    pollMap,
    userMap,
    mentionCache,
    linkPreviewMap,
    authorPrivacyMap,
    recentReplierMap,
    orphanAuthorMap,
    resolvedMap,
    quoteCountMap,
    replyParentAuthorIdByPostId,
    selfContinuationPostIds,
    laneMap,
    crosspostMap,
    importMap,
    signingChannelIds,
  } = params;

  const postId = resolveId(post);
  if (!postId) return null;
  const imported = importMap.get(postId);

  const isFederatedPost = !!post?.federation;

  // A post normally carries a resolved `oxyUserId` — the federated-actor → Oxy
  // user link is enforced at ingest, so NEW federated posts always have one and
  // the author renders through the canonical Oxy `name.displayName` path
  // (buildUserMap / resolveUserSummaries). Two exceptions are handled here:
  //  - A NATIVE post with no author is a genuine data error → dropped.
  //  - A FEDERATED post with no author is a legacy "orphan" (ingested before the
  //    link was enforced, e.g. a brid.gy/Bluesky-bridged note). It still renders
  //    in a DEGRADED form — its content plus a federation-derived author (see
  //    buildOrphanFederatedAuthorMap) — so a boost/quote referencing it, and the
  //    post itself, is not blank. The degraded author is transient/never cached,
  //    so the DTO self-heals once `oxyUserId` is backfilled.
  let orphanAuthor: PostUser | undefined;
  let authorId = post?.oxyUserId ? String(post.oxyUserId) : undefined;
  if (!authorId) {
    if (!isFederatedPost) return null;
    orphanAuthor = orphanAuthorMap.get(postId) ?? degradedActorSummary(postId);
    authorId = orphanAuthor.id;
  }

  const authorship = normalizeAuthorship(post.authorship as PostAuthorshipEntry[] | undefined);

  // `resolveUserSummaries` always populates an entry for every requested id
  // (a real user or the degraded fallback), so this default is defensive — but
  // it must STILL never emit the raw id as a handle if ever reached. An orphan
  // federated post uses its federation-derived author (its `oxyUserId` is null,
  // so there is nothing in `userMap`), and its authorship carries no usable
  // owner — the byline falls back to `user` from an empty `authors[]`.
  //
  // A CHANNEL post takes this same path and no other. The channel is an Oxy
  // account and authors its own posts, so `authorId` IS the channel and `user`
  // resolves through the ordinary identity route — real handle, real avatar,
  // real `name.displayName`. `user` stays the channel whatever the byline
  // says: the channel is the signature.
  const user = orphanAuthor ?? userMap.get(authorId) ?? degradedActorSummary(authorId);
  const headerEntries = orphanAuthor ? [] : getHeaderAuthorshipEntries(authorship);
  const authors: HydratedAuthor[] = headerEntries.map((entry) => {
    const summary = userMap.get(entry.oxyUserId) ?? degradedActorSummary(entry.oxyUserId);
    return {
      ...summary,
      role: entry.role,
      status: entry.status,
    };
  });

  // The human behind a channel post, named only when the channel says to.
  //
  // FAIL-CLOSED. {@link disclosesWriters} owns both disclosure clauses — the
  // account has to BE a channel, and that channel has to be in
  // `signingChannelIds`, which holds only accounts whose settings row says
  // `signPosts === true`, so a missing row, a channel that never opted in and
  // a failed lookup are all absent from it. The remaining conditions here are
  // about the BYLINE rather than about consent: the post has to carry a
  // writer, and that writer must not already be in it.
  //
  // `userMap` only holds the writer when the SAME conditions already sent the
  // id to the batch, so an undisclosed writer is not merely unrendered: they
  // were never resolved, and `writtenByOxyUserId` has no DTO field to leak
  // through either. Anonymity does not depend on this branch being right.
  //
  // Appended to an EXISTING byline, never used to start one: `authors` leads
  // with the owner, so a lone writer would read as the primary author — the
  // one thing `user` staying the channel is meant to prevent.
  const writerId = typeof post.writtenByOxyUserId === 'string' ? post.writtenByOxyUserId : '';
  if (
    writerId &&
    authors.length > 0 &&
    disclosesWriters(authorId, user, signingChannelIds) &&
    !authors.some((author) => author.id === writerId)
  ) {
    const writer = userMap.get(writerId);
    // Absent only if the batch never resolved them; a resolve MISS still
    // yields the degraded summary, which renders as "Unknown user" with no
    // handle rather than as a raw id.
    if (writer) {
      authors.push({ ...writer, role: 'writer', status: 'accepted' });
    }
  }

  const baseContent: StoredPostContent = post?.content ?? {};
  const resolved = resolvedMap.get(postId) ?? resolveVariant(baseContent);
  const extendedContext = viewerContext as ExtendedViewerContext;
  const postMentions: string[] =
    Array.isArray(post.mentions) && post.mentions.length > 0
      ? post.mentions.filter((mention): mention is string => typeof mention === 'string')
      : [];
  const inlineVariants = await buildInlineVariants(
    baseContent,
    resolved.tag,
    postMentions,
    mentionCache,
    extendedContext.includeFullArticleBody !== false,
  );
  const content = buildContent(post, pollMap, viewerContext, resolved, inlineVariants);
  const attachments = buildAttachments(post, pollMap, resolved);
  const documents = linkPreviewMap.documents.get(postId) ?? [];
  const documentsPending = linkPreviewMap.pending.has(postId);
  const viewerState = buildViewerState(post, postId, viewerContext, authorship);
  const permissions = buildPermissions(post, authorId, viewerContext, authorship);
  const authorPrivacy = authorPrivacyMap.get(authorId) ?? { ...DEFAULT_PRIVACY };
  const replierAvatars = recentReplierMap?.get(postId);
  const engagement = buildEngagement(
    post,
    authorPrivacy,
    replierAvatars,
    quoteCountMap ? (quoteCountMap.get(postId) ?? 0) : undefined,
  );

  // Only include essential metadata for feed performance
  const includeFullMetadata =
    (params.viewerContext as ExtendedViewerContext).includeFullMetadata !== false;
  // Guarded rather than converted inline like `createdAt`: this field is
  // optional, so an unparseable value is reachable, and `toISOString()` throws
  // on one — which would fail the whole hydration, not just this field.
  const scheduledAt = post.scheduledFor
    ? new Date(post.scheduledFor as string | number | Date)
    : null;
  const scheduledFor =
    scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt.toISOString() : undefined;
  // The correction marker. Both halves are REQUIRED to emit it: a count with no
  // timestamp could not say when the post changed, and the summary's whole job
  // is to be openable. Guarded like `scheduledFor` above, and for the same
  // reason — the column is nullable, so an unparseable value is reachable and
  // `toISOString()` throws on one, which would fail the entire hydration.
  const correctedAt = post.lastCorrectedAt
    ? new Date(post.lastCorrectedAt as string | number | Date)
    : null;
  const corrections =
    typeof post.correctionCount === 'number' &&
    post.correctionCount > 0 &&
    correctedAt &&
    !Number.isNaN(correctedAt.getTime())
      ? { count: post.correctionCount, lastCorrectedAt: correctedAt.toISOString() }
      : undefined;
  const metadata = {
    visibility: (post.visibility ?? PostVisibility.PUBLIC) as PostVisibility,
    replyPermission: post.replyPermission as
      | import('@mention/shared-types').ReplyPermission[]
      | undefined,
    reviewReplies: Boolean(post.reviewReplies),
    quotesDisabled: Boolean(post.quotesDisabled),
    isPinned: Boolean(post.metadata?.isPinned),
    // OUTSIDE the `includeFullMetadata` gate on purpose: that gate exists to
    // keep large arrays (mentions, hashtags) off feed rows, and this is one
    // boolean the feed is the main consumer of. The edit HISTORY is not
    // exposed anywhere — only the fact.
    isEdited: Boolean(post.isEdited),
    isSensitive: Boolean(post.metadata?.isSensitive),
    // Content-warning label from the federated source (Mastodon `summary`), or
    // the one an IMPORTED post carried on its platform (a native post has no CW
    // text of its own, so the import ledger keeps it). The frontend renders it
    // as a spoiler/CW header; absent for every other post.
    spoilerText: post.federation?.spoilerText || imported?.contentWarning || undefined,
    isThread: Boolean(post.threadId),
    language: post.language || undefined,
    languages: post.postClassification?.languages ?? undefined,
    // Only include mentions/hashtags if needed (can be large arrays)
    mentions:
      includeFullMetadata && Array.isArray(post.mentions) && post.mentions.length > 0
        ? post.mentions.filter((m): m is string => typeof m === 'string')
        : undefined,
    // A private mention's audience, always: the reader is its author or one of
    // these people (the ACL above), and who else is in the conversation is part
    // of reading it.
    recipients:
      post.visibility === PostVisibility.DIRECT && Array.isArray(post.recipients)
        ? post.recipients.filter((id): id is string => typeof id === 'string')
        : undefined,
    hashtags:
      includeFullMetadata && Array.isArray(post.hashtags) && post.hashtags.length > 0
        ? post.hashtags
        : undefined,
    createdAt: new Date(
      (post.createdAt || post.date || Date.now()) as string | number | Date,
    ).toISOString(),
    updatedAt: new Date(
      (post.updatedAt || post.createdAt || Date.now()) as string | number | Date,
    ).toISOString(),
    corrections,
    status: post.status as 'draft' | 'published' | 'scheduled' | undefined,
    // Only a scheduled post carries one, and the ACL above already dropped
    // every unpublished post for anyone but its owner/collaborators — so this
    // is emitted unconditionally rather than gated on `status`, which would
    // only duplicate that check somewhere it could drift.
    scheduledFor,
  };

  // Always replace mentions in text if they exist, regardless of includeFullMetadata
  // This ensures mentions are always displayed correctly. Runs on the RESOLVED
  // body (`content.text` is already this reader's language), so a localized
  // rendition never leaks a raw `[mention:<id>]` placeholder.
  const finalText = await resolveMentionText(
    typeof content?.text === 'string' ? content.text : '',
    postMentions,
    mentionCache,
  );

  if (content) {
    content.text = finalText;
  }

  const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
  const includeAuthorship = viewerEntry != null;

  // Empty when the parent is absent, unreadable by this viewer, or an orphan
  // federated post with no Oxy author — the post is still marked as a reply,
  // it simply names nobody.
  const parentAuthorId = replyParentAuthorIdByPostId.get(postId);
  const parentAuthor = parentAuthorId ? userMap.get(parentAuthorId) : undefined;
  const replyContext: PostReplyContext = parentAuthor ? { parentAuthor } : {};
  // A community that did not resolve has no handle to name it by, so the post
  // simply renders without its "in !community" row.
  const community = post.communityOxyUserId ? userMap.get(post.communityOxyUserId) : undefined;

  return {
    id: postId,
    content: content ?? { text: finalText },
    attachments,
    documents,
    ...(documentsPending ? { documentsPending: true } : {}),
    user,
    authors,
    ...(includeAuthorship ? { authorship } : {}),
    engagement,
    viewerState,
    permissions,
    metadata,
    // Absent when the post has no lane, and absent when its lane row is gone
    // (the delete cascade unsets `laneId` before removing the Lane, so this is
    // only reachable if that cascade was interrupted — a missing chip, which
    // is harmless).
    ...(typeof post.laneId === 'string' && laneMap.has(post.laneId)
      ? { lane: laneMap.get(post.laneId) }
      : {}),
    // Cross-post provenance — `Instagram · Threads` — when this post is one
    // variant of a piece of writing published to two networks. Absent
    // otherwise, which is almost always, and absent for a cluster that somehow
    // holds a single member: one network is not provenance, it is the post.
    ...(buildCrosspostProvenance(crosspostMap.get(postId)) ?? {}),
    ...(community && !isFallbackUserSummary(community) ? { community } : {}),
    // "Originally posted on Mastodon" — only for a post that was imported.
    ...(imported
      ? { importedFrom: { platform: imported.platform, sourceUrl: imported.sourceUrl } }
      : {}),
    // Include parentPostId for thread hierarchy in replies
    ...(post.parentPostId ? { parentPostId: String(post.parentPostId) } : {}),
    // The reply marker rides on the POST, so every surface that renders one —
    // sliced feed, flat feed, search, saved, thread view — can say "Replying
    // to @…" from the DTO alone. The stored `is_reply` column is the single
    // definition, so a federated reply whose `inReplyTo` never resolved is
    // still marked; it just names nobody. Self-thread continuations are the one
    // exclusion — they are replies, but they are rendered as a THREAD, not as
    // reply context. See `PostReplyContext`.
    ...(post.isReply === true && !selfContinuationPostIds.has(postId) ? { replyContext } : {}),
  };
}

/**
 * Normalize a raw `content.media` array (strings or objects from lean docs)
 * into typed {@link MediaItem}s carrying `id`/`type` plus the optional `alt`
 * (accessibility description). URL resolution is applied separately via
 * {@link resolveMediaItems}, which passes `alt` through unchanged.
 */
function normalizeMediaItems(
  rawMedia: unknown,
): import('@mention/shared-types').MediaItem[] | undefined {
  if (!Array.isArray(rawMedia)) {
    return undefined;
  }
  const items = rawMedia
    .map((item: unknown): import('@mention/shared-types').MediaItem | undefined => {
      if (!item) return undefined;
      if (typeof item === 'string') {
        return { id: item, type: 'image' };
      }
      if (typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (obj.id) {
          const persisted = readPersistedMediaFields(obj);
          return {
            id: String(obj.id),
            type:
              obj.type === 'video' || obj.type === 'gif' ? (obj.type as 'video' | 'gif') : 'image',
            ...persisted,
          };
        }
      }
      return undefined;
    })
    .filter((x): x is import('@mention/shared-types').MediaItem => x !== undefined);
  return items;
}

/**
 * The renditions shipped INLINE on the DTO so a reader can switch language with
 * no round trip: every AUTHOR variant, plus the machine translation for the
 * language being served when one is cached ({@link readerVariants}).
 *
 * Emitted ONLY when there is more than one: a monolingual post's single variant
 * IS `content.text`, and shipping it again would duplicate every body in every
 * feed payload. Each variant carries an ALREADY-RESOLVED rendition — its media
 * appears only when that variant overrides it (a replaced set, or the shared set
 * with the variant's localized `alt` merged in), so the client swaps in what it
 * is handed and never re-implements the inheritance rule.
 */
export async function buildInlineVariants(
  content: StoredPostContent,
  servedTag: string | undefined,
  postMentions: string[],
  mentionCache: Map<string, PostUser>,
  includeFullArticleBody: boolean,
): Promise<PostContentVariant[] | undefined> {
  const switchable = readerVariants(content, servedTag);
  if (switchable.length < 2) return undefined;

  const inline: PostContentVariant[] = [];
  for (const variant of switchable) {
    const rendition = resolveVariant(content, variant.tag);
    const overridesMedia = variant.media !== undefined || variant.alt !== undefined;
    const normalizedMedia = overridesMedia ? normalizeMediaItems(rendition.media) : undefined;
    const article = variant.article && rendition.article;

    inline.push({
      ...(variant.tag ? { tag: variant.tag } : {}),
      source: variant.source,
      text: await resolveMentionText(variant.text, postMentions, mentionCache),
      ...(normalizedMedia && normalizedMedia.length > 0
        ? { media: resolveMediaItems(normalizedMedia) }
        : {}),
      ...(article
        ? {
            article: {
              title: article.title,
              excerpt: article.excerpt,
              ...(includeFullArticleBody && article.body ? { body: article.body } : {}),
            },
          }
        : {}),
      ...(variant.createdAt ? { createdAt: variant.createdAt } : {}),
    });
  }
  return inline;
}

export function buildContent(
  post: RawPost,
  pollMap: Map<string, Record<string, unknown>>,
  viewerContext: ViewerContext | undefined,
  resolved: ResolvedVariant,
  inlineVariants: PostContentVariant[] | undefined,
): Record<string, unknown> {
  const baseContent: StoredPostContent = post?.content ?? {};

  // The media the RESOLVED rendition shows: the shared set with this language's
  // alt descriptions merged in, or the set the variant replaced it with.
  const normalizedMedia = normalizeMediaItems(resolved.media);
  const media = normalizedMedia ? resolveMediaItems(normalizedMedia) : undefined;

  const pollId = baseContent.pollId;
  const poll = pollId ? pollMap.get(String(pollId)) : undefined;
  const article = resolved.article;

  return {
    // Already resolved for THIS reader — every renderer that reads `content.text`
    // (video captions, notification previews, quote cards, the share sheet, SEO,
    // the server-rendered OG, MCP) shows the right language without knowing this
    // feature exists. It is not stored anywhere: the body lives only on the
    // variant this resolved to.
    text: resolved.text,
    // The tag actually served — what the UI shows as "Showing in Spanish".
    textLang: resolved.tag,
    variants: inlineVariants,
    title: baseContent.title,
    commerce: baseContent.commerce,
    linkUrl: baseContent.linkUrl,
    media,
    poll,
    pollId: pollId ? String(pollId) : undefined,
    // For feed, only include article metadata, not full body (saves bandwidth)
    article: article
      ? {
          articleId: article.articleId,
          title: article.title,
          excerpt: article.excerpt,
          // Only include body if explicitly requested (e.g., for detail view)
          ...((viewerContext as ExtendedViewerContext)?.includeFullArticleBody && article.body
            ? { body: article.body }
            : {}),
        }
      : undefined,
    sources: Array.isArray(baseContent.sources) ? baseContent.sources : undefined,
    location: baseContent.location,
    event: baseContent.event,
    room: baseContent.room,
    homiioCase:
      sanitizeHomiioCase(baseContent.homiioCase) ?? homiioCaseFromText(resolved.text ?? ''),
    vibbrEvent:
      sanitizeVibbrEvent(baseContent.vibbrEvent) ?? vibbrEventFromText(resolved.text ?? ''),
    attachments: Array.isArray(baseContent.attachments) ? baseContent.attachments : undefined,
  };
}

export function buildAttachments(
  post: RawPost,
  pollMap: Map<string, Record<string, unknown>>,
  resolved: ResolvedVariant,
): PostAttachmentBundle {
  const content = post?.content ?? {};
  const attachments: PostAttachmentBundle = {};
  if (content.commerce?.length) attachments.commerce = content.commerce;

  // The attachment bundle renders the SAME rendition as `content` — a reader
  // served the Spanish body must get the Spanish alt text on the same images.
  const normalizedMedia = normalizeMediaItems(resolved.media);
  if (normalizedMedia && normalizedMedia.length > 0) {
    attachments.media = resolveMediaItems(normalizedMedia);
  }

  const pollId = content.pollId;
  if (pollId) {
    const poll = pollMap.get(String(pollId));
    if (poll) {
      attachments.poll = poll as unknown as import('@mention/shared-types').PollData;
    }
  } else if (content.poll) {
    attachments.poll = content.poll;
  }

  if (resolved.article) {
    attachments.article = {
      articleId: resolved.article.articleId,
      title: resolved.article.title,
      body: resolved.article.body,
      excerpt: resolved.article.excerpt,
    };
  }

  if (Array.isArray(content.sources) && content.sources.length > 0) {
    attachments.sources = (content.sources as Array<{ url: string; title?: string }>).map(
      (source: { url: string; title?: string }) => ({
        url: source.url,
        title: source.title,
      }),
    );
  }

  if (content.location?.coordinates?.length === 2) {
    attachments.location = content.location;
  }

  if (content.event) {
    attachments.event = {
      eventId: content.event.eventId,
      name: content.event.name,
      date: content.event.date,
      location: content.event.location,
      description: content.event.description,
    };
  }

  const roomData = content.room;
  if (roomData) {
    attachments.room = {
      roomId: roomData.roomId,
      title: roomData.title,
      status: roomData.status,
      topic: roomData.topic,
      host: roomData.host,
    };
  }

  attachments.homiioCase =
    sanitizeHomiioCase(content.homiioCase) ?? homiioCaseFromText(resolved.text ?? '');
  attachments.vibbrEvent =
    sanitizeVibbrEvent(content.vibbrEvent) ?? vibbrEventFromText(resolved.text ?? '');

  attachments.podcast = sanitizePodcast(content.podcast) ?? undefined;

  if (content.job) {
    attachments.job = {
      mentionJobId: content.job.mentionJobId,
      title: content.job.title,
      employerName: content.job.employerName,
      employerOxyUserId: content.job.employerOxyUserId,
      status: content.job.status,
      canonicalUrl: content.job.canonicalUrl,
      location: content.job.location,
      workplaceType: content.job.workplaceType,
      employmentType: content.job.employmentType,
    };
  }

  return attachments;
}

/**
 * `isOwner` is what the client's post menu draws itself from — delete, edit,
 * pin, move to lane, reply options — so it has to name everybody who may
 * actually manage the post.
 *
 * `authorship` alone does not. A CHANNEL post's owner entry is the CHANNEL,
 * an account nobody can ever be signed in as, so on `authorship` alone every
 * channel post is unmanageable by everyone — the menu comes up empty for the
 * person who wrote it. The writer is carried in `writtenByOxyUserId` and never
 * in `authorship` (putting them there would break the channel's anonymity and
 * put the post back on their own profile), which is why this reads both.
 *
 * **It is a HINT about a permission a third party can revoke, and the two
 * disagreements it leaves run in opposite directions.** The write routes prove
 * CURRENT membership against Oxy's account graph
 * (`postManagementRefusal`); this runs once per post per hydration and cannot
 * afford to ask. So:
 *
 *  - a co-operator who did not write the post sees no button and would be
 *    accepted by the route — affordance ⊂ permission, the safe direction;
 *  - a writer who has LEFT the channel is still named by
 *    `writtenByOxyUserId`, is still drawn the menu, and is refused by every
 *    route it offers. That is the unsafe direction, and it is accepted
 *    deliberately: dropping the clause would leave `isOwner` false for every
 *    human alive on every channel post outside the editorial queue, taking the
 *    menu away from the people currently running the channel in order to spare
 *    the people who left a 404. The argument in full is on
 *    `postManagementRefusal`.
 */
function buildViewerState(
  post: RawPost,
  postId: string,
  viewerContext: ViewerContext,
  authorship: PostAuthorshipEntry[],
): PostViewerState {
  const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
  const isOwner =
    viewerEntry?.role === 'owner' || canManagePostWithoutLookup(post, viewerContext.viewerId);
  const isCollaborator = viewerEntry?.role === 'collaborator' && viewerEntry.status === 'accepted';

  return {
    isOwner,
    isCollaborator,
    collabInvitePending: viewerEntry?.role === 'collaborator' && viewerEntry.status === 'pending',
    viewerRole: viewerEntry?.role,
    isLiked: viewerContext.likedPosts.has(postId),
    isDownvoted: viewerContext.downvotedPosts.has(postId),
    isReposted: viewerContext.boostedPosts.has(postId),
    // Deprecated duplicate for clients shipped before the rename.
    isBoosted: viewerContext.boostedPosts.has(postId),
    isSaved: viewerContext.savedPosts.has(postId),
  };
}

function buildPermissions(
  post: RawPost,
  authorId: string,
  viewerContext: ViewerContext,
  authorship: PostAuthorshipEntry[],
): PostPermissions {
  const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
  // Same reading as `buildViewerState` — and it has to be the same, or the
  // menu and the permission flags beside it would disagree about one post.
  const isOwner =
    viewerEntry?.role === 'owner' || canManagePostWithoutLookup(post, viewerContext.viewerId);
  const isAcceptedCollaborator =
    viewerEntry?.role === 'collaborator' && viewerEntry.status === 'accepted';
  const canReply = computeReplyPermission(post, authorId, viewerContext);

  return {
    canReply,
    canDelete: isOwner,
    canPin: isOwner,
    canViewSources: Boolean(post?.content?.sources?.length),
    canEdit: isOwner,
    canStopSharing: isAcceptedCollaborator,
    canViewInsights: isOwner || isAcceptedCollaborator,
  };
}

function computeReplyPermission(
  post: RawPost,
  authorId: string,
  viewerContext: ViewerContext,
): boolean {
  const viewerId = viewerContext.viewerId;
  if (!viewerId) return false;
  if (viewerId === authorId) return true;

  const permissions: string[] = post?.replyPermission || ['anyone'];

  if (permissions.includes('anyone')) return true;
  if (permissions.includes('nobody')) return false;

  for (const perm of permissions) {
    switch (perm) {
      case 'followers':
        if (viewerContext.follows.has(authorId)) return true;
        break;
      case 'following':
        if (viewerContext.followedBy.has(authorId)) return true;
        break;
      case 'mentioned':
        if (
          Array.isArray(post?.mentions) &&
          post.mentions.some((mention: unknown) => {
            const mentionId =
              typeof mention === 'string'
                ? mention
                : typeof mention === 'object' && mention
                  ? String(
                      (mention as Record<string, unknown>).id ||
                        (mention as Record<string, unknown>)._id ||
                        (mention as Record<string, unknown>).oxyUserId ||
                        '',
                    )
                  : '';
            return mentionId && String(mentionId) === viewerId;
          })
        )
          return true;
        break;
    }
  }

  return false;
}

function buildEngagement(
  post: RawPost,
  authorPrivacy: typeof DEFAULT_PRIVACY,
  recentReplierAvatars?: string[],
  quotesCount?: number,
): PostEngagementSummary {
  const stats = post?.stats || {};
  const likesCount = typeof stats.likesCount === 'number' ? stats.likesCount : 0;
  const downvotesCount = typeof stats.downvotesCount === 'number' ? stats.downvotesCount : 0;
  const repostsCount = typeof stats.boostsCount === 'number' ? stats.boostsCount : 0;
  const repliesCount = typeof stats.commentsCount === 'number' ? stats.commentsCount : 0;
  const savesCount = typeof stats.savesCount === 'number' ? stats.savesCount : 0;

  const viewsCount = typeof stats.viewsCount === 'number' ? stats.viewsCount : 0;

  return {
    likes: authorPrivacy.hideLikeCounts ? null : likesCount,
    downvotes: authorPrivacy.hideLikeCounts ? null : downvotesCount,
    reposts: authorPrivacy.hideShareCounts ? null : repostsCount,
    // Deprecated duplicate for clients shipped before the rename.
    boosts: authorPrivacy.hideShareCounts ? null : repostsCount,
    replies: authorPrivacy.hideReplyCounts ? null : repliesCount,
    saves: authorPrivacy.hideSaveCounts ? null : savesCount,
    // Absent unless the caller asked for quote counts. Hidden by the same
    // author control as boosts — a quote is a share of the post.
    quotes:
      quotesCount === undefined ? undefined : authorPrivacy.hideShareCounts ? null : quotesCount,
    views: viewsCount > 0 ? viewsCount : null,
    impressions: null,
    recentReplierAvatars: recentReplierAvatars?.length ? recentReplierAvatars : undefined,
  };
}

export function attachNestedContext(
  post: RawPost,
  summary: HydratedPostSummary,
  summaryMap: Map<string, HydratedPostSummary>,
  collectedPostIds: Set<string>,
  publicReferencesOnly: boolean,
  recordsById: ReadonlyMap<string, RawPost>,
): HydratedPost | null {
  const repostOf = extractRepostOriginalId(post);
  const quoteOf = extractReferenceIds({ quoteOf: post.quoteOf })[0];

  const quotedPost = quoteOf ? (summaryMap.get(quoteOf) ?? null) : null;
  const repostOriginal = repostOf ? (summaryMap.get(repostOf) ?? null) : null;

  let originalPost: HydratedPostSummary | null = null;
  if (repostOf) {
    originalPost = repostOriginal;
  } else if (quoteOf) {
    originalPost = quotedPost;
  }

  let repostContext: HydratedRepostContext | null = null;
  if (repostOf) {
    if (repostOriginal) {
      repostContext = { originalPost: repostOriginal, actor: summary.user };
    } else if (!publicReferencesOnly && !collectedPostIds.has(repostOf)) {
      // The boosted original was force-collected but no post row came back — it
      // is genuinely GONE (deleted, or a never-imported federated original).
      // A boost has an empty body, so instead of a blank card we surface an
      // `unavailable` marker for the client to render a placeholder. This is
      // deliberately distinct from an original that WAS collected but whose
      // summary was dropped by an ACL/visibility check for this viewer (id IS in
      // `collectedPostIds`) — that stays `boost: null` so a private post's
      // existence is never revealed. On public-broadcast surfaces
      // (`publicReferencesOnly`) a filtered-out original is indistinguishable
      // from a gone one at the query layer, so we stay conservative and keep
      // `boost: null` there too.
      repostContext = { originalPost: null, actor: summary.user, unavailable: true };
    }
  }

  const context = buildContext(post);
  const quotedUrls = quoteOf ? quotedPostUrls(recordsById.get(quoteOf)) : [];

  return {
    ...summary,
    originalPost,
    quotedPost,
    ...(quotedUrls.length > 0 ? { quotedPostUrls: quotedUrls } : {}),
    ...((quoteOf || post.type === 'quote') && !quotedPost ? { quotedPostUnavailable: true } : {}),
    repost: repostContext,
    // Deprecated duplicate for clients shipped before the rename.
    boost: repostContext,
    context,
  };
}

function buildContext(post: RawPost) {
  if (!post?.threadId && !post?.parentPostId) {
    return undefined;
  }

  return {
    parentThreadId: post.threadId ? String(post.threadId) : undefined,
    isThreadParent: !post.parentPostId && Boolean(post.threadId),
  };
}
