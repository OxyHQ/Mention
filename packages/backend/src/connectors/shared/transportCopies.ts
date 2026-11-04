import type { MediaItem, PostContentVariant, StoredPostContent } from '@mention/shared-types';
import { enqueueFederatedMediaDeletions } from '../../db/federation/mediaDeletionRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import {
  linkReplyToParent,
  loadPostRecord,
  replacePostContent,
  updatePostRecord,
} from '../../db/posts/postRepository';
import {
  loadTransportCopies,
  type MergedProvenancePatch,
  type TransportCopyRow,
  updateMergedProvenance,
  upsertTransportCopies,
} from '../../db/posts/postTransportCopyRepository';
import type { TransportCopyFacts } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { eq } from 'drizzle-orm';
import { POST_CLASSIFICATION_PENDING } from '../../db/posts/postRecord';
import { authorVariants } from '../../services/postVariants';
import { logger } from '../../utils/logger';

/**
 * ONE UPSTREAM POST, SEVERAL COPIES — MERGED, NOT PICKED.
 *
 * When two transports deliver the same upstream post (they meet on its upstream
 * key, `./upstreamPostKey.ts`), Mention keeps ONE post and gives it everything
 * either copy carried. Each copy's facts are kept (`post_transport_copies`) and
 * the post is the merge of all of them, computed by {@link mergeTransportCopies}
 * in a FIXED order, so the result is the same whichever copy arrived first.
 *
 * THE ORDER. Copies are ranked: the network's own protocol or API (a native
 * atproto post, the Instagram Graph API) before a bridge ({@link transportRank}),
 * then by object id.
 *
 * THE RULES, field by field:
 *
 *  - Published time, URL, reply target URI: the first copy in that order that
 *    has one. A missing value is filled; a disagreement goes to the
 *    higher-ranked copy.
 *  - The quoted post and the parent post: filled when the stored post has none,
 *    never replaced (that would move counters and audiences over a disagreement
 *    between bridges).
 *  - Text: the first copy whose text is not a TRUNCATION of another copy's (its
 *    text, without a trailing `…`, is a proper prefix of the other's). A longer
 *    copy beats a cut-off one whatever their rank.
 *  - Media: ONE copy's set, never a union of two CDN copies of the same image:
 *    the text copy's when it has media, else the first copy that has any.
 *    Alt text missing on an item is taken from another copy only when that copy
 *    has exactly as many items, of the same types, in the same order.
 *  - Language and content warning: the first copy that has one.
 *  - Sensitive: if ANY copy says so.
 *
 * A Delete from one transport removes only its copy while another still asserts
 * the post (`releaseTransportCopy`), and an Update from any copy's transport is
 * that copy's new facts, merged again by the same rules.
 */

/** One transport copy: its object id, the actor that delivered it, and what it said. */
export type TransportCopy = TransportCopyRow;

/**
 * 0 for a copy read from the network's own protocol or API, 1 for a bridge's.
 * Decided by the copy's object id, not its actor: a Graph-imported Instagram
 * post (`instagram:<shortcode>`) is stored under the kilogram actor it shares
 * with the bridge, and a native atproto post is its at-URI.
 */
export function transportRank(objectUri: string): 0 | 1 {
  return objectUri.startsWith('at://') || objectUri.startsWith('instagram:') ? 0 : 1;
}

/** What the merged post shows, and which copy each part comes from. */
export interface MergedTransportPost {
  publishedAt?: string;
  url?: string;
  inReplyTo?: string;
  quoteOf?: string;
  replyTo?: { parentPostId: string; threadId: string };
  language?: string;
  sensitive: boolean;
  spoilerText?: string;
  /** The copy whose text the post shows. */
  textFrom: string;
  /** The copy whose media set the post shows; undefined when no copy has media. */
  mediaFrom?: string;
  /** The alt text of each item of `mediaFrom`'s set, filled from the others. */
  mediaAlts: Array<string | undefined>;
}

/** `a` is `b` cut short: without a trailing ellipsis, a proper prefix of it. */
function isTruncationOf(a: string, b: string): boolean {
  const cut = a.replace(/\s*(?:…|\.\.\.)\s*$/u, '').trimEnd();
  return cut.length > 0 && cut.length < b.trimEnd().length && b.startsWith(cut);
}

function sameMediaShape(a: TransportCopyFacts['media'], b: TransportCopyFacts['media']): boolean {
  return a.length === b.length && a.every((item, index) => item.type === b[index].type);
}

/** The merge of every copy of one post, by the rules above. Pure. */
export function mergeTransportCopies(copies: readonly TransportCopy[]): MergedTransportPost {
  if (copies.length === 0) throw new Error('mergeTransportCopies needs at least one copy');
  const ordered = [...copies].sort(
    (a, b) =>
      a.facts.rank - b.facts.rank ||
      (a.objectUri < b.objectUri ? -1 : a.objectUri > b.objectUri ? 1 : 0),
  );
  const first = <K extends keyof TransportCopyFacts>(key: K): TransportCopyFacts[K] | undefined =>
    ordered.find((copy) => copy.facts[key] !== undefined && copy.facts[key] !== '')?.facts[key];

  const textCopy =
    ordered.find((copy) =>
      ordered.every(
        (other) => other === copy || !isTruncationOf(copy.facts.text, other.facts.text),
      ),
    ) ?? ordered[0];
  const mediaCopy =
    textCopy.facts.media.length > 0
      ? textCopy
      : ordered.find((copy) => copy.facts.media.length > 0);
  const mediaAlts = (mediaCopy?.facts.media ?? []).map(
    (item, index) =>
      item.alt ??
      ordered.find(
        (other) =>
          other !== mediaCopy &&
          sameMediaShape(other.facts.media, mediaCopy?.facts.media ?? []) &&
          other.facts.media[index].alt,
      )?.facts.media[index].alt,
  );

  return {
    publishedAt: first('publishedAt'),
    url: first('url'),
    inReplyTo: first('inReplyTo'),
    quoteOf: first('quoteOf'),
    replyTo: first('replyTo'),
    language: first('language'),
    sensitive: ordered.some((copy) => copy.facts.sensitive),
    spoilerText: first('spoilerText'),
    textFrom: textCopy.objectUri,
    mediaFrom: mediaCopy?.objectUri,
    mediaAlts,
  };
}

/** A copy's facts from its post as it would be stored. */
export function transportCopyFacts(post: {
  objectUri: string;
  content: StoredPostContent;
  createdAt?: Date;
  url?: string;
  inReplyTo?: string;
  quoteOf?: string | null;
  replyTo?: { parentPostId: string; threadId: string } | null;
  language?: string;
  sensitive?: boolean;
  spoilerText?: string;
}): TransportCopyFacts {
  return {
    rank: transportRank(post.objectUri),
    ...(post.createdAt ? { publishedAt: post.createdAt.toISOString() } : {}),
    ...(post.url ? { url: post.url } : {}),
    ...(post.inReplyTo ? { inReplyTo: post.inReplyTo } : {}),
    ...(post.quoteOf ? { quoteOf: post.quoteOf } : {}),
    ...(post.replyTo ? { replyTo: post.replyTo } : {}),
    text: authorVariants(post.content)[0]?.text ?? '',
    media: (post.content.media ?? []).map((item) => ({
      type: item.type,
      ...(item.alt ? { alt: item.alt } : {}),
    })),
    ...(post.language ? { language: post.language } : {}),
    sensitive: post.sensitive === true,
    ...(post.spoilerText ? { spoilerText: post.spoilerText } : {}),
  };
}

/** The one copy a post row is before any merge: the row itself. */
function copyOfStoredPost(record: PostRecord): TransportCopy | undefined {
  const objectUri = record.federation?.activityId;
  const actorUri = record.federation?.actorUri;
  if (!objectUri || !actorUri) return undefined;
  return {
    objectUri,
    actorUri,
    facts: transportCopyFacts({
      objectUri,
      content: record.content,
      createdAt: record.createdAt,
      url: record.federation?.url,
      inReplyTo: record.federation?.inReplyTo,
      quoteOf: record.quoteOf,
      replyTo:
        record.parentPostId && record.threadId
          ? { parentPostId: record.parentPostId, threadId: record.threadId }
          : null,
      language: record.language,
      sensitive: record.metadata.isSensitive || record.federation?.sensitive === true,
      spoilerText: record.federation?.spoilerText,
    }),
  };
}

/** A copy that has just arrived, with the content it would be stored with. */
export interface IncomingTransportCopy extends TransportCopy {
  content: StoredPostContent;
  mentions: readonly string[];
}

function contentSignature(content: StoredPostContent): string {
  return JSON.stringify({
    variants: (content.variants ?? []).map((variant) => [variant.tag, variant.text]),
    media: (content.media ?? []).map((item) => [item.id, item.alt ?? null]),
    title: content.title ?? null,
    linkUrl: content.linkUrl ?? null,
  });
}

/**
 * Merge an arriving copy into the post that already holds its upstream key
 * (`postId`), by {@link mergeTransportCopies}. Records every copy, writes the
 * merged fields, and queues the arriving copy's re-hosted media for deletion
 * when the merged post does not use them. `edited` says the copy is an Update of
 * one already recorded. Returns `false` when the post is gone.
 */
export async function absorbTransportCopy(
  postId: string,
  incoming: IncomingTransportCopy,
  options: { edited?: boolean } = {},
): Promise<boolean> {
  const record = await loadPostRecord(postId);
  if (!record) return false;
  const recorded = await loadTransportCopies(postId);
  const stored = recorded.length > 0 ? recorded : [copyOfStoredPost(record)].filter((c) => !!c);
  const copies = [
    ...stored.filter((copy) => copy.objectUri !== incoming.objectUri),
    { objectUri: incoming.objectUri, actorUri: incoming.actorUri, facts: incoming.facts },
  ];
  const merged = mergeTransportCopies(copies);

  const textSource = merged.textFrom === incoming.objectUri ? incoming.content : record.content;
  const mediaSource =
    merged.mediaFrom === incoming.objectUri
      ? incoming.content
      : merged.mediaFrom
        ? record.content
        : undefined;
  const media: MediaItem[] = (mediaSource?.media ?? []).map((item, index) => {
    const alt = item.alt ?? merged.mediaAlts[index];
    return alt ? { ...item, alt } : item;
  });
  const variants: PostContentVariant[] | undefined = textSource.variants;
  const content: StoredPostContent = {
    ...record.content,
    variants,
    title: textSource.title ?? record.content.title,
    linkUrl: textSource.linkUrl ?? record.content.linkUrl ?? incoming.content.linkUrl,
    media: media.length > 0 ? media : undefined,
    attachments: mediaSource?.attachments,
  };
  const contentChanged = contentSignature(content) !== contentSignature(record.content);

  const patch: MergedProvenancePatch = {
    createdAt: merged.publishedAt ? new Date(merged.publishedAt) : undefined,
    federationUrl: merged.url,
    federationInReplyTo: merged.inReplyTo,
    federationSpoilerText: merged.spoilerText,
    federationSensitive: merged.sensitive,
    metadataIsSensitive: merged.sensitive,
    // References are only ever ADDED. Two copies of one post name one quoted
    // post and one parent; replacing a stored link would move counters and
    // audiences for a disagreement between bridges, not for an edit.
    quoteOf: record.quoteOf ?? merged.quoteOf,
    language: record.language ?? merged.language,
    ...(record.parentPostId === null && merged.replyTo ? { isReply: true } : {}),
    ...(options.edited && contentChanged ? { isEdited: true } : {}),
  };

  await upsertTransportCopies(postId, [
    ...stored.filter((copy) => copy.objectUri !== incoming.objectUri),
    { objectUri: incoming.objectUri, actorUri: incoming.actorUri, facts: incoming.facts },
  ]);
  if (contentChanged) {
    const mentions = merged.textFrom === incoming.objectUri ? incoming.mentions : record.mentions;
    await replacePostContent(postId, content, mentions);
    // The body changed, so what the classifier said about it is stale.
    await updatePostRecord(postId, {
      postClassification: { status: POST_CLASSIFICATION_PENDING, attempts: 0 },
    });
  }
  await updateMergedProvenance(postId, patch);
  // The reply link, with its parent's counter and audience, as any late link.
  if (record.parentPostId === null && merged.replyTo) {
    await linkReplyToParent(eq(posts.id, postId), merged.replyTo);
  }

  const kept = new Set((content.media ?? []).map((item) => item.id));
  const unused = (incoming.content.media ?? [])
    .filter((item) => item.cachedFromFederation && !kept.has(item.id))
    .map((item) => item.id);
  if (unused.length > 0) await enqueueFederatedMediaDeletions(unused);

  logger.debug('[Federation] merged a transport copy into its upstream post', {
    copies: copies.length,
    contentChanged,
  });
  return true;
}
