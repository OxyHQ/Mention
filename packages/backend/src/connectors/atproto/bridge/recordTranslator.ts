/**
 * MTN → atproto record translation (Phase C4 — the heart of the be-discovered
 * bridge).
 *
 * A Mention user's signed-record chain stores `app.mention.feed.*` payloads (the
 * inner `record` of a {@link SignedRecordEnvelope}). To be readable from a
 * Bluesky AppView, each MTN record is PROJECTED into its `app.bsky.feed.*`
 * equivalent at read time — a pure, lossless-where-possible mapping, no network
 * I/O. The functions here are the single source of truth for that projection so
 * the `listRecords` / `getRecord` / `getAuthorFeed` views cannot drift.
 *
 * The MTN lexicon was deliberately modelled on atproto's, so the mapping is
 * mostly structural:
 *  - `app.mention.feed.post`   → `app.bsky.feed.post`   (text/facets/reply/langs/tags/embed)
 *  - `app.mention.feed.like`   → `app.bsky.feed.like`   (subject → strongRef)
 *  - `app.mention.feed.repost` → `app.bsky.feed.repost` (subject → strongRef)
 *  - `app.mention.feed.tombstone` / `.bookmark` are NOT projected — a tombstone is
 *    a deletion applied to the materialized view, a bookmark is private.
 *
 * URI translation: an MTN `subject`/`reply` URI is `mtn://<oxyUserId>/<col>/<rkey>`;
 * the atproto equivalent is `at://<did:web subject>/<bsky col>/<rkey>`. The bsky
 * `*Ref`/`strongRef` shape needs a CID; the MTN chain does not mint a CID per
 * record, so the bridge synthesizes a stable, deterministic placeholder CID from
 * the record's content address (see {@link mtnRecordIdToCid}). A foreign AppView
 * uses the `uri` for identity and tolerates an opaque `cid`; full MST/CAR
 * fidelity (real content-addressed CIDs) is the FLAGGED next sub-phase.
 */

import {
  MtnUri,
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  type MentionPostRecord,
  type MentionLikeRecord,
  type MentionRepostRecord,
  type MtnFacet,
  type MtnFacetFeature,
  type MtnMediaEmbed,
} from '@mention/shared-types';
import { buildUserDid } from '../../../services/mtn/mentionDid';
import {
  BSKY_POST_COLLECTION,
  BSKY_LIKE_COLLECTION,
  BSKY_REPOST_COLLECTION,
} from './constants';
import { blobContentRef } from './blobUrl';

/** The MTN feed collection → its served `app.bsky.feed.*` equivalent. */
export const MTN_TO_BSKY_COLLECTION: Readonly<Record<string, string>> = {
  [MENTION_POST_COLLECTION]: BSKY_POST_COLLECTION,
  [MENTION_LIKE_COLLECTION]: BSKY_LIKE_COLLECTION,
  [MENTION_REPOST_COLLECTION]: BSKY_REPOST_COLLECTION,
};

/** The reverse map: an `app.bsky.feed.*` collection → its MTN source collection. */
export const BSKY_TO_MTN_COLLECTION: Readonly<Record<string, string>> = {
  [BSKY_POST_COLLECTION]: MENTION_POST_COLLECTION,
  [BSKY_LIKE_COLLECTION]: MENTION_LIKE_COLLECTION,
  [BSKY_REPOST_COLLECTION]: MENTION_REPOST_COLLECTION,
};

/** An atproto strong reference: the record's AT-URI plus its CID. */
export interface AtprotoStrongRef {
  uri: string;
  cid: string;
}

/** An `app.bsky.feed.post#replyRef`: the thread root + direct parent strong refs. */
export interface AtprotoReplyRef {
  root: AtprotoStrongRef;
  parent: AtprotoStrongRef;
}

/** An `app.bsky.richtext.facet#byteSlice`. */
interface AtprotoByteSlice {
  byteStart: number;
  byteEnd: number;
}

/** An `app.bsky.richtext.facet` feature (mention / link / tag). */
type AtprotoFacetFeature =
  | { $type: 'app.bsky.richtext.facet#mention'; did: string }
  | { $type: 'app.bsky.richtext.facet#link'; uri: string }
  | { $type: 'app.bsky.richtext.facet#tag'; tag: string };

/** An `app.bsky.richtext.facet`. */
interface AtprotoFacet {
  $type: 'app.bsky.richtext.facet';
  index: AtprotoByteSlice;
  features: AtprotoFacetFeature[];
}

/** An `app.bsky.embed.images` image item: a blob ref + alt text. */
interface AtprotoImage {
  alt: string;
  image: AtprotoBlobValue;
  aspectRatio?: { width: number; height: number };
}

/**
 * An atproto blob value (`$type: blob`). The bridge does NOT re-encode bytes into
 * a real CID-keyed blob (that needs CAR/MST fidelity — the flagged sub-phase), so
 * the blob carries the content-addressing `ref` derived from the MTN `sha256`
 * plus the bytes' MIME + size. A reader that just renders media uses the
 * `cloud.oxy.so` URL the bridge also surfaces; a strict AppView treats the blob
 * ref as opaque.
 */
interface AtprotoBlobValue {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

/** A translated `app.bsky.feed.post` record value. */
export interface AtprotoPostRecordValue {
  $type: 'app.bsky.feed.post';
  text: string;
  createdAt: string;
  facets?: AtprotoFacet[];
  reply?: AtprotoReplyRef;
  langs?: string[];
  tags?: string[];
  embed?: AtprotoImagesEmbed;
}

/** An `app.bsky.embed.images` embed. */
interface AtprotoImagesEmbed {
  $type: 'app.bsky.embed.images';
  images: AtprotoImage[];
}

/** A translated `app.bsky.feed.like` / `app.bsky.feed.repost` record value. */
export interface AtprotoSubjectRecordValue {
  $type: 'app.bsky.feed.like' | 'app.bsky.feed.repost';
  subject: AtprotoStrongRef;
  createdAt: string;
}

/** Any record value the bridge projects. */
export type AtprotoRecordValue = AtprotoPostRecordValue | AtprotoSubjectRecordValue;

/**
 * Build the AT-URI for an MTN record key under the user's `did:web` subject DID.
 * `at://<did:web:oxy.so:u:<oxyUserId>>/<bsky collection>/<rkey>`.
 */
export function buildBridgeAtUri(oxyUserId: string, bskyCollection: string, rkey: string): string {
  return `at://${buildUserDid(oxyUserId)}/${bskyCollection}/${rkey}`;
}

/**
 * Derive a stable, deterministic placeholder CID for a record from its MTN
 * content address (`recordId`, the sha256 of the canonical signing input). This
 * is NOT a real atproto CID (no MST/CAR encoding); it is a deterministic,
 * collision-free token so `strongRef.cid` is populated and stable across reads.
 * Real CIDs are the flagged CAR/commit-signing sub-phase. Prefixed `mtn-` so it
 * is never mistaken for a genuine IPLD CIDv1.
 */
export function mtnRecordIdToCid(recordId: string | undefined): string {
  return recordId && recordId.length > 0 ? `mtn-${recordId}` : 'mtn-unknown';
}

/**
 * Translate an MTN URI (`mtn://<oxyUserId>/<mtn collection>/<rkey>`) into an
 * atproto strong ref (`at://<did>/<bsky collection>/<rkey>` + a placeholder CID).
 * Returns null when the MTN URI is malformed or its collection has no served
 * atproto equivalent (so a reply/subject pointing at a non-projected collection
 * is simply dropped rather than emitting a dangling ref).
 */
export function mtnUriToStrongRef(mtnUri: string): AtprotoStrongRef | null {
  if (!MtnUri.isValid(mtnUri)) return null;
  const parts = MtnUri.parse(mtnUri);
  const bskyCollection = MTN_TO_BSKY_COLLECTION[parts.collection];
  if (!bskyCollection) return null;
  return {
    uri: buildBridgeAtUri(parts.identity, bskyCollection, parts.rkey),
    // The referenced record's CID is not known from the URI alone; a deterministic
    // placeholder derived from the rkey keeps the ref stable. (A real CID would
    // require resolving the referenced record's content address — out of scope
    // for the read view; the URI is the load-bearing identity field.)
    cid: mtnRecordIdToCid(parts.rkey),
  };
}

/** Map an MTN facet feature to its `app.bsky.richtext.facet` feature. */
function translateFacetFeature(feature: MtnFacetFeature): AtprotoFacetFeature | null {
  switch (feature.type) {
    case 'mention':
      // MTN stores the mentioned user's DID (an oxyUserId-derived did:web); atproto
      // mention features carry a `did`, so this maps directly.
      return { $type: 'app.bsky.richtext.facet#mention', did: feature.did };
    case 'link':
      return { $type: 'app.bsky.richtext.facet#link', uri: feature.uri };
    case 'hashtag':
      return { $type: 'app.bsky.richtext.facet#tag', tag: feature.tag };
    default:
      // An unknown feature kind (forward-compat / malformed) is dropped rather
      // than emitting a partial facet.
      return null;
  }
}

/** Translate the MTN facet list to `app.bsky.richtext.facet[]`. */
function translateFacets(facets: MtnFacet[] | undefined): AtprotoFacet[] | undefined {
  if (!facets || facets.length === 0) return undefined;
  const out: AtprotoFacet[] = [];
  for (const facet of facets) {
    const features = facet.features
      .map(translateFacetFeature)
      .filter((f): f is AtprotoFacetFeature => f !== null);
    if (features.length === 0) continue;
    out.push({
      $type: 'app.bsky.richtext.facet',
      index: { byteStart: facet.index.byteStart, byteEnd: facet.index.byteEnd },
      features,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Translate an MTN media embed to an `app.bsky.embed.images`. Video/gif blobs
 * have no clean `app.bsky.embed.images` representation, so only `image` items are
 * projected (a video would need `app.bsky.embed.video` with a real CID-keyed blob
 * — the flagged CAR sub-phase). The blob carries the content-addressing ref from
 * the MTN `sha256`; readers that just render use the `cloud.oxy.so` URL.
 */
function translateEmbed(embed: MtnMediaEmbed | undefined): AtprotoImagesEmbed | undefined {
  if (!embed || embed.items.length === 0) return undefined;
  const images: AtprotoImage[] = [];
  for (const item of embed.items) {
    if (item.blob.mediaType !== 'image') continue;
    images.push({
      alt: item.alt ?? '',
      image: {
        $type: 'blob',
        ref: { $link: item.blob.sha256 },
        mimeType: item.blob.mime ?? 'image/jpeg',
        size: item.blob.size ?? 0,
      },
    });
  }
  if (images.length === 0) return undefined;
  return { $type: 'app.bsky.embed.images', images };
}

/** Translate an MTN reply ref (root/parent MTN URIs) to an `app.bsky.feed.post#replyRef`. */
function translateReply(reply: { root: string; parent: string } | undefined): AtprotoReplyRef | undefined {
  if (!reply) return undefined;
  const root = mtnUriToStrongRef(reply.root);
  const parent = mtnUriToStrongRef(reply.parent);
  if (!root || !parent) return undefined;
  return { root, parent };
}

/** Translate an `app.mention.feed.post` payload into an `app.bsky.feed.post` value. */
export function translatePostRecord(record: MentionPostRecord): AtprotoPostRecordValue {
  const value: AtprotoPostRecordValue = {
    $type: 'app.bsky.feed.post',
    text: record.text,
    createdAt: record.createdAt,
  };

  const facets = translateFacets(record.facets);
  if (facets) value.facets = facets;

  const reply = translateReply(record.reply);
  if (reply) value.reply = reply;

  if (record.langs && record.langs.length > 0) value.langs = [...record.langs];
  if (record.tags && record.tags.length > 0) value.tags = [...record.tags];

  const embed = translateEmbed(record.embed);
  if (embed) value.embed = embed;

  return value;
}

/** Translate an `app.mention.feed.like` payload into an `app.bsky.feed.like` value. */
export function translateLikeRecord(record: MentionLikeRecord): AtprotoSubjectRecordValue | null {
  const subject = mtnUriToStrongRef(record.subject);
  if (!subject) return null;
  return { $type: 'app.bsky.feed.like', subject, createdAt: record.createdAt };
}

/** Translate an `app.mention.feed.repost` payload into an `app.bsky.feed.repost` value. */
export function translateRepostRecord(record: MentionRepostRecord): AtprotoSubjectRecordValue | null {
  const subject = mtnUriToStrongRef(record.subject);
  if (!subject) return null;
  return { $type: 'app.bsky.feed.repost', subject, createdAt: record.createdAt };
}

/** A blob in an MTN post embed, surfaced with its content address. */
export interface BridgeBlobView {
  sha256: string;
  mediaType: 'image' | 'video' | 'gif';
  mime?: string;
  size?: number;
  /**
   * The content-addressed reference for the blob (the `sha256`). NOT a fetchable
   * HTTP URL — a by-`sha256` CDN resolver is the flagged blob-layer sub-phase (see
   * `blobUrl.ts`).
   */
  contentRef: string;
}

/**
 * Surface the blob views for an MTN post embed (the content addresses of every
 * media item). Returns an empty array when the post has no media. The renderable
 * URL is the flagged blob-layer sub-phase — these carry the content address only.
 */
export function postEmbedBlobViews(record: MentionPostRecord): BridgeBlobView[] {
  if (!record.embed || record.embed.items.length === 0) return [];
  return record.embed.items.map((item) => {
    const view: BridgeBlobView = {
      sha256: item.blob.sha256,
      mediaType: item.blob.mediaType,
      contentRef: blobContentRef(item.blob.sha256),
    };
    if (item.blob.mime) view.mime = item.blob.mime;
    if (typeof item.blob.size === 'number') view.size = item.blob.size;
    return view;
  });
}
