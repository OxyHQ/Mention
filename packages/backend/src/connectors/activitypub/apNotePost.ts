import { mentionTextsFromContent } from '@mention/shared-types/mentions';
import type { FederationImportReason } from '../../db/schema/federationImports';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { loadPostRecord } from '../../db/posts/postRepository';
import { type FederatedPollInput, syncFederatedPoll } from '../../db/polls/pollRepository';
import {
  classifyPostBaseline,
  type CreatePostParams,
  derivePostType,
} from '../../services/PostCreationService';
import { isFediverseSharingEnabled } from '../../services/fediverseSharing';
import { authorVariants, toStoredContent } from '../../services/postVariants';
import { getPostCreator } from '../../services/serviceRegistry';
import { parentIsChannelPost } from '../../utils/channelReplyGate';
import { logger } from '../../utils/logger';
import { buildAuthorship } from '../../utils/postAuthorship';
import { reconcileMentionIdsForPost } from '../../utils/textProcessing';
import { type RemoteLinkPreview, storeRemoteLinkPreviews } from '../shared/linkPreviews';
import { getRemoteHost } from '../shared/url';
import { absorbTransportCopy, transportCopyFacts } from '../shared/transportCopies';
import { resolvePostCommunity } from './apCommunity';
import { extractApLanguage, extractApLanguages } from './apLanguage';
import {
  type ApAudience,
  type ApAudienceAuthor,
  type AuthorRefreshOptions,
  applyMentionPlaceholders,
  type ResolvedInboundMentions,
  resolveApAudienceFor,
  resolveInboundMentions,
} from './apMentions';
import { buildFederatedNoteContent, buildFederatedNoteProvenance } from './apPostContent';
import { extractLocalPostIdFromApUri, FEDERATION_MAX_CONTENT_LENGTH } from './constants';
import {
  extractDeclaredQuote,
  extractInReplyToUri,
  parseApPublished,
  resolveDeclaredQuoteTarget,
  stripQuoteMarkerFromVariants,
} from './helpers';
import { identityDomainOfActor } from './identityDomain';
import { isBridgeFlattenedRetweet } from './flattenedRetweet';
import { transportHandoffRefusal } from './transportHandoff';

/**
 * AN ACTIVITYPUB NOTE → A POST, ONCE.
 *
 * Three roads import a remote Note: the inbox `Create`, the outbox backfill, and
 * the dependency import (a boosted original, a reply ancestor, a quoted note,
 * the pinned post, a public status). Each used to assemble the post itself — its
 * body, audience, mentions, quote, language, community and status — and each
 * rule that changed reached one road before the others: the quote link, the
 * flattened-retweet gate, the author's actor type and the channel reply gate
 * were each, for a while, applied on one road and not another, so the same Note
 * was stored differently depending on how it arrived.
 *
 * {@link buildPostFromNote} is now the only place a Note becomes a post. The
 * roads differ only in what is genuinely theirs: how the author was resolved and
 * whether to wait for it (the inbox retries its job, the outbox retries its run),
 * how the thread link is made (before the insert, or after a page's batch
 * insert), and how the row is written ({@link storeNotePost} through
 * `PostCreationService`, or {@link notePostRecord} for the outbox's batch
 * insert).
 */

/** A note's author: its actor row, already linked to an Oxy user. */
export interface NoteAuthor extends ApAudienceAuthor {
  oxyUserId: string;
  /** The AP actor type — the classifier's RSS/bot-mirror signal. */
  type?: string | null;
  /** The host that delivered the actor; its URI's host when absent. */
  domain?: string | null;
  /** The identity Oxy re-labelled a bridged actor with (`alice@x.com`). */
  networkAcct?: string | null;
}

export interface BuildPostFromNoteInput {
  /** The Note (or Article / Page / Question), validated by the caller. */
  note: Record<string, unknown>;
  /** The activity that carried it, when there was one — its `published` is the fallback date. */
  activity?: Record<string, unknown>;
  /** The Note's own AP id: its dedup key and federated identity. */
  activityId: string;
  author: NoteAuthor;
  importReason: FederationImportReason;
  ingestPath: 'inbox' | 'outbox' | 'dependency';
  /** The community that relayed the note (`apRelay.ts`), which vouches for its community. */
  relayedBy?: string;
  /** Mentions the caller already resolved (the outbox resolves a page at once). */
  mentions?: ResolvedInboundMentions;
  /** The caller's memo of author re-reads ({@link resolveApAudienceFor}). */
  audienceRefreshes?: AuthorRefreshOptions['refreshes'];
  /** Imports a quoted note this instance does not hold yet; null when it cannot. */
  importQuoted: (uri: string) => Promise<string | null>;
}

/** The post a Note becomes, in the shape `PostCreationService.create` takes. */
export type NotePostParams = Pick<
  CreatePostParams,
  | 'content'
  | 'quoteOf'
  | 'communityOxyUserId'
  | 'visibility'
  | 'recipients'
  | 'hashtags'
  | 'mentions'
  | 'language'
  | 'languages'
  | 'instanceDomain'
  | 'actorType'
  | 'status'
  | 'metadata'
  | 'createdAt'
  | 'updatedAt'
> & {
  oxyUserId: string;
  federation: NonNullable<CreatePostParams['federation']>;
  visibility: NonNullable<CreatePostParams['visibility']>;
  status: 'published' | 'incomplete';
};

export interface NotePost {
  skip?: false;
  params: NotePostParams;
  audience: ApAudience;
  mentions: ResolvedInboundMentions;
  /** The parent's AP URI, for a reply; the caller links the thread. */
  inReplyToUri: string | undefined;
  /** FEP-8967 cards, stored beside the post once it exists. */
  linkPreviews: RemoteLinkPreview[];
  /** A `Question`'s poll, stored once the post exists. */
  poll: FederatedPollInput | null;
}

export interface SkippedNotePost {
  skip: true;
  reason: string;
}

/**
 * Whether the LOCAL owner of `postId` currently allows fediverse sharing.
 * `true` (proceed) when the post is missing, mirrored from elsewhere
 * (`federation` set, so its "owner" is a remote actor) or has no local owner.
 * Redis-cached and fails OPEN on an Oxy outage, like every consent read here.
 *
 * Asked before anything creates NEW engagement on an existing local post — a
 * reply (below), a Like, an Announce, a poll vote — so an opted-out user's
 * content stops accruing it the moment sharing is off. Never asked by an Undo:
 * teardown must always converge.
 */
export async function isLocalPostOwnerSharingEnabled(postId: string): Promise<boolean> {
  const post = await loadPostRecord(postId);
  if (!post || post.federation != null || !post.oxyUserId) return true;
  return isFediverseSharingEnabled(post.oxyUserId);
}

/**
 * Why a reply is refused before anything is built, or null when it is not.
 *
 * Only a LOCAL parent can refuse: a remote object, imported or not, is authored
 * by a remote actor, which is never a local channel and has no Mention consent.
 * So the parent is read off the URI, and the ordinary remote-to-remote reply
 * costs no lookup at all.
 *
 *  - A channel's post takes no replies (`utils/channelReplyGate`).
 *  - A local user who turned fediverse sharing off receives none.
 *
 * Both are a silent DROP on every road, never a throw: a throw fails the inbox
 * job into retry, and a backfill has nobody to answer.
 */
async function refusedReplyReason(inReplyToUri: string): Promise<string | null> {
  const localParentId = extractLocalPostIdFromApUri(inReplyToUri);
  if (!localParentId) return null;
  if (await parentIsChannelPost(localParentId)) return 'reply-to-channel-post';
  if (!(await isLocalPostOwnerSharingEnabled(localParentId))) return 'reply-to-unshared-post';
  return null;
}

/**
 * Turn a Note into the post it stores as, or say why it stores as nothing.
 *
 * In order: the size cap, the transport handoff (`./transportHandoff`), the reply gates, who the note is for (a direct note
 * to none of our users is dropped before any mention is resolved), the
 * mentions, the body and media (`buildFederatedNoteContent`), the quote (a
 * quoted post we lack is imported through `importQuoted`, and an unresolved one
 * withholds the post as `incomplete`), and the community. Nothing is written.
 */
export async function buildPostFromNote(
  input: BuildPostFromNoteInput,
): Promise<NotePost | SkippedNotePost> {
  const { note, author, activityId } = input;

  const rawContent = typeof note.content === 'string' ? note.content : '';
  if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) return { skip: true, reason: 'oversized' };

  // A retweet a reviewed bridge flattened into a Note under the retweeter's
  // byline, with no reference to the original. Decided on the bridge's own text,
  // before any mention becomes a placeholder; every road (inbox Create, outbox
  // backfill, dependency import) builds here, so this is the one gate.
  if (isBridgeFlattenedRetweet(note, author.uri))
    return { skip: true, reason: 'flattened-retweet' };

  // An account reached through a keyless and a keyed transport takes each post
  // from exactly one of them, split at the account's handoff (`./transportHandoff`).
  const published = parseApPublished(note.published ?? input.activity?.published);
  const inReplyToUri = extractInReplyToUri(note.inReplyTo);
  const handoff = await transportHandoffRefusal(author, {
    activityId,
    published,
    isReply: inReplyToUri !== undefined,
    // The dependency import stores what something else references (a boost's
    // original, a quote target, a reply ancestor), and only when no copy with
    // its upstream key exists.
    role: input.ingestPath === 'dependency' ? 'referenced' : 'own',
  });
  if (handoff) return { skip: true, reason: handoff };

  const refused = inReplyToUri ? await refusedReplyReason(inReplyToUri) : null;
  if (refused) return { skip: true, reason: refused };

  const audience = await resolveApAudienceFor(note, author, {
    refreshes: input.audienceRefreshes,
  });
  if (!audience) return { skip: true, reason: 'direct-to-nobody' };

  // Each `Mention` anchor becomes a `[mention:<id>]` placeholder BEFORE the body
  // is derived, so hydration renders it as a profile link, not dead `@user` text.
  const mentions = input.mentions ?? (await resolveInboundMentions(note));
  const noteObject = applyMentionPlaceholders(note, mentions.anchorMap);

  const authorHost = author.domain ?? getRemoteHost(author.uri) ?? '';
  const built = await buildFederatedNoteContent(noteObject, author.oxyUserId, {
    activityId,
    actorUri: author.uri,
    // The author's IDENTITY network, so the bare handles they typed are stored
    // qualified (`x.com` for a bridged actor, nothing for an ordinary one).
    identityDomain: identityDomainOfActor({ networkAcct: author.networkAcct, domain: authorHost }),
    ingestPath: input.ingestPath,
  });
  if (built.skip) return built;

  // A quote links to the local post, importing it when we lack it; the remote's
  // `RE: <url>` fallback is then a duplicate of the card and is removed. Threads
  // carries its quote only in the body, which `extractDeclaredQuote` also reads.
  const declaredQuote = extractDeclaredQuote(note, author.uri);
  const quoteOf = declaredQuote
    ? await resolveDeclaredQuoteTarget(declaredQuote, input.importQuoted)
    : null;
  const variants = await stripQuoteMarkerFromVariants(built.variants, quoteOf, declaredQuote?.uri);

  return {
    params: {
      oxyUserId: author.oxyUserId,
      federation: buildFederatedNoteProvenance({
        importReason: input.importReason,
        activityId,
        actorUri: author.uri,
        inReplyTo: inReplyToUri,
        noteUrl: note.url,
        sensitive: built.sensitive,
        spoilerText: built.summary,
      }),
      quoteOf,
      communityOxyUserId: await resolvePostCommunity(note, input.relayedBy, author),
      content: {
        // The body's ONLY home: one variant per `contentMap` language, primary first.
        variants: variants.length > 0 ? variants : undefined,
        title: built.title,
        linkUrl: built.linkUrl,
        media: built.media.length > 0 ? built.media : undefined,
        attachments: built.attachments.length > 0 ? built.attachments : undefined,
      },
      visibility: audience.visibility,
      ...(audience.recipients.length > 0 ? { recipients: audience.recipients } : {}),
      hashtags: built.hashtags,
      mentions: mentions.ids,
      // The declared primary and the full declared set; the classifier resolves
      // the stored language from them.
      language: extractApLanguage(note),
      languages: extractApLanguages(note),
      instanceDomain: getRemoteHost(author.uri),
      actorType: author.type ?? undefined,
      // WITHHELD when the note quotes something we could not produce: its text
      // was written about that post. Stored rather than dropped, so the quoted-
      // post backfill can promote it if the quote ever resolves.
      status: declaredQuote && !quoteOf ? 'incomplete' : 'published',
      metadata: { isSensitive: built.sensitive },
      // The remote publish date, not when we happened to receive it.
      ...(published ? { createdAt: published, updatedAt: published } : {}),
    },
    audience,
    mentions,
    inReplyToUri,
    linkPreviews: built.linkPreviews,
    poll: built.poll,
  };
}

/** Log a skipped note at debug, with the reason the builder gave. */
export function logSkippedNote(path: string, skipped: SkippedNotePost): void {
  logger.debug(`[Federation] skipped a ${path} note`, { result: skipped.reason });
}

/**
 * Store a built note through `PostCreationService` — the inbox and the
 * dependency import — then its link cards and poll. Federated: no
 * notifications, socket event or outbound delivery from here.
 */
export async function storeNotePost(
  post: NotePost,
  placement: {
    parentPostId?: string | null;
    threadId?: string | null;
    /** A community hosted here that relays the post overrides the note's own. */
    communityOxyUserId?: string | null;
  } = {},
): Promise<PostRecord> {
  const created = await getPostCreator().create({
    ...post.params,
    ...(placement.communityOxyUserId ? { communityOxyUserId: placement.communityOxyUserId } : {}),
    parentPostId: placement.parentPostId ?? null,
    threadId: placement.threadId ?? null,
    skipNotifications: true,
    skipSocketEmit: true,
    skipFederationDelivery: true,
  });
  await storeNoteExtras(created.id, post);
  return created;
}

/** A stored note's FEP-8967 cards and poll — written once the post row exists. */
export async function storeNoteExtras(
  postId: string,
  post: Pick<NotePost, 'linkPreviews' | 'poll' | 'params'>,
): Promise<void> {
  if (post.linkPreviews.length > 0) await storeRemoteLinkPreviews(postId, post.linkPreviews);
  if (post.poll) await syncFederatedPoll(postId, post.params.oxyUserId, post.poll);
}

/**
 * The row the outbox backfill batch-inserts for a built note.
 *
 * The batch skips `PostCreationService` (one transaction per row, no per-row
 * read-back; see `insertPostRecords`), so it takes from that service exactly the
 * pieces a federated post goes through there: the Stage-A classification
 * (`classifyPostBaseline`), the stored content with the resolved language on its
 * primary variant (`toStoredContent`), the mention allowlist reconciled against
 * the stored body, and the post type.
 */
export async function notePostRecord(post: NotePost, id: string): Promise<PostRecordInput> {
  const { params } = post;
  const primaryText = authorVariants(params.content)[0]?.text ?? '';
  const baseline = await classifyPostBaseline(params, primaryText);
  const language = baseline.language ?? params.language;
  const content = toStoredContent(params.content, language);
  return {
    id,
    oxyUserId: params.oxyUserId,
    authorship: buildAuthorship(params.oxyUserId, []),
    federation: params.federation,
    type: derivePostType({ quoteOf: params.quoteOf, content }),
    communityOxyUserId: params.communityOxyUserId ?? null,
    content,
    quoteOf: params.quoteOf ?? null,
    visibility: params.visibility,
    ...(params.recipients ? { recipients: params.recipients } : {}),
    hashtags: params.hashtags ?? [],
    mentions: reconcileMentionIdsForPost(mentionTextsFromContent(content), params.mentions),
    ...(language ? { language } : {}),
    status: params.status,
    metadata: params.metadata ?? {},
    ...(baseline.postClassification ? { postClassification: baseline.postClassification } : {}),
    ...(params.createdAt ? { createdAt: params.createdAt, updatedAt: params.updatedAt } : {}),
  };
}

/**
 * Merge a built note into the post that already holds its upstream key — the
 * same upstream post, delivered by another transport (`../shared/transportCopies`).
 * `replyTo` is the note's thread link when the caller resolved one.
 */
export async function absorbNoteCopy(
  postId: string,
  post: NotePost,
  replyTo?: { parentPostId: string; threadId: string } | null,
  options: { edited?: boolean } = {},
): Promise<boolean> {
  const { params } = post;
  const objectUri = params.federation.activityId;
  const actorUri = params.federation.actorUri;
  if (!objectUri || !actorUri) return false;
  const record = await notePostRecord(post, postId);
  return absorbTransportCopy(
    postId,
    {
      objectUri,
      actorUri,
      facts: transportCopyFacts({
        objectUri,
        content: record.content,
        createdAt: params.createdAt,
        url: params.federation.url,
        inReplyTo: params.federation.inReplyTo,
        quoteOf: params.quoteOf,
        replyTo,
        language: record.language,
        sensitive: params.metadata?.isSensitive,
        spoilerText: params.federation.spoilerText,
      }),
      content: record.content,
      mentions: record.mentions ?? [],
    },
    options,
  );
}
