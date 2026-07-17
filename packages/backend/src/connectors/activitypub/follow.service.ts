import { logger } from '../../utils/logger';
import FederatedActor, { IFederatedActor } from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import FederationDeliveryQueue from '../../models/FederationDeliveryQueue';
import UserSettings from '../../models/UserSettings';
import { Post } from '../../models/Post';
import Poll from '../../models/Poll';
import { signRequest, getPublicKey } from './crypto';
import {
  FEDERATION_DOMAIN,
  FEDERATION_ENABLED,
  AP_CONTEXT,
  AP_CONTENT_TYPE,
  USER_AGENT,
  actorUrl,
  hashtagUrl,
  resolveOxyUser,
} from './constants';
import { buildLocalActorObject, type ActorUserView } from './actorObject';
import { PostVisibility, canonicalizeLanguageTag, type MediaItem, type PostContent } from '@mention/shared-types';
import { authorVariants, resolveVariant } from '../../services/postVariants';
import { enqueueDelivery } from '../../queue/producers';
import { isFediverseSharingEnabled } from '../../services/fediverseSharing';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import type { LocalBoostEventPayload } from '@oxyhq/federation';
import { actorService } from './actor.service';
import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import { assertSafePublicUrl } from '../../utils/ssrfGuard';
import { resolveMediaRef } from '../../utils/mediaResolver';
import { linkifyApHtml, type ApMentionLink, type LinkifyApHtmlOptions } from '../../utils/federation/linkifyApHtml';
import { normalizeHashtag, normalizeMentionIds } from '../../utils/textProcessing';
import { getNormalizedUserHandle, type User as OxyUser } from '@oxyhq/core';
import { isAbsoluteHttpUrl } from '../shared/url';

const DELIVER_ACTIVITY_TIMEOUT_MS = 15000;
const DELIVERY_RESPONSE_PREVIEW_MAX_BYTES = 1024;

/** The ActivityStreams public collection — the `to` addressee of a public activity. */
const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/**
 * The canonical AP object id of a boosted/replied/liked ORIGINAL post, plus the
 * original author's remote inbox and actor URI when the original is federated.
 *
 * `objectUri` is what an `Announce`/`Undo(Announce)` (and later a reply's
 * `inReplyTo`, a Like's `object`) points at. `authorInbox` is an EXPLICIT
 * delivery target unioned into the follower set so the original author's
 * instance learns about the interaction; it is undefined for a local original
 * (that author is us — reached through their own followers, never a remote POST).
 */
interface FederationTarget {
  objectUri: string;
  authorActorUri?: string;
  authorInbox?: string;
  /**
   * The author's fediverse acct (`user@domain`) — the source of a reply's
   * `Mention` tag `name` (`@<acct>`). For a federated original it is the stored
   * `FederatedActor.acct`; for a local original it is `<username>@<domain>`.
   */
  authorAcct?: string;
}

/**
 * MIME derivation for an ActivityPub media `attachment`. Extension-first (for the
 * federated raw URLs / CDNs that carry one), otherwise a category default keyed
 * off the stored media `type`. Every default is a MIME Mastodon accepts, so an
 * attachment is never dropped for an "unsupported mediaType"; remote servers
 * re-derive the exact type when they download the file, so a category-level hint
 * (e.g. `image/jpeg` for a PNG served id-only from our CDN) is corrected there.
 */
const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
const ATTACHMENT_MIME_BY_TYPE: Record<MediaItem['type'], string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  gif: 'image/gif',
};

/**
 * Build one ActivityStreams `Document` attachment from a stored post media item,
 * or `undefined` when it cannot be resolved to an absolute URL. Native Oxy file
 * ids are resolved through the canonical media chokepoint (`resolveMediaRef`);
 * federated media stored as a raw absolute URL is advertised verbatim (never
 * proxied back out to the fediverse). Fail-soft: any resolution problem yields
 * `undefined` so a single bad item never breaks the Note.
 */
function buildNoteAttachment(item: MediaItem | undefined | null): Record<string, unknown> | undefined {
  const ref = item?.id;
  if (!ref) return undefined;

  let url: string | undefined;
  try {
    url = isAbsoluteHttpUrl(ref) ? ref : resolveMediaRef(ref).url || undefined;
  } catch {
    return undefined;
  }
  if (!url || !isAbsoluteHttpUrl(url)) return undefined;

  // Extension from the PATHNAME only — never the host (its dots would yield a
  // bogus "extension"). Absent/unknown → category default below.
  let extension: string | undefined;
  try {
    extension = new URL(url).pathname.split('.').pop()?.toLowerCase();
  } catch {
    extension = undefined;
  }
  const mediaType =
    (extension && ATTACHMENT_MIME_BY_EXT[extension]) ||
    ATTACHMENT_MIME_BY_TYPE[item?.type as MediaItem['type']] ||
    'image/jpeg';

  const attachment: Record<string, unknown> = { type: 'Document', mediaType, url };
  // Alt text → AP `name` (accessibility description), when the author provided one.
  if (item?.alt) attachment.name = item.alt;
  // Intrinsic pixel dimensions (persisted at ingest) — Mastodon uses them for
  // aspect-ratio/layout. Emit each only when it is a real positive dimension;
  // never advertise a `null`/`0` placeholder.
  if (typeof item?.width === 'number' && item.width > 0) attachment.width = item.width;
  if (typeof item?.height === 'number' && item.height > 0) attachment.height = item.height;
  return attachment;
}

/**
 * The post fields the Note builder reads. A lean `Post` document satisfies it —
 * every caller (push delivery, the outbox page, the per-post dereference route)
 * already has one, so nothing re-fetches.
 */
export interface NoteSourcePost {
  _id: unknown;
  content: PostContent;
  hashtags?: string[];
  mentions?: string[];
  createdAt: string | Date;
  /**
   * Post-level flags read at Note-build time. Only `isSensitive` (the author's
   * CW/NSFW compose toggle) is federated — it becomes the Note's `sensitive`
   * boolean so Mastodon blurs the media / hides the body behind a
   * content-warning click. Absent/undefined ⇒ not sensitive. The toggle is
   * boolean-only (there is no CW TEXT), so no `summary` is emitted.
   */
  metadata?: { isSensitive?: boolean } | null;
  /**
   * Set when the post is a boost. A boost has an intentionally empty body and
   * MUST federate as an `Announce`, never as a blank `Create(Note)` — the
   * federation entry point ({@link FollowService.federateNewPost}) reads this to
   * re-route the post to the Announce path.
   */
  boostOf?: string | null;
  /**
   * The local Post `_id` of the parent when this post is a REPLY. Drives the
   * Note's `inReplyTo` + parent-author `Mention` addressing: the federation
   * caller resolves the parent's canonical AP object uri + author via
   * {@link FollowService.resolveReplyContext} and passes it into the pure Note
   * builder. Absent for a top-level post.
   */
  parentPostId?: string | null;
  /**
   * The local Post `_id` of the QUOTED post when this post is a quote. A quote
   * post is a normal Note (its own commentary in `content`) PLUS a reference to
   * the quoted object: the federation caller resolves the quoted post's canonical
   * AP object uri via {@link FollowService.resolveQuoteContext} and passes it into
   * the pure Note builder, which emits the FEP-044f/FEP-e232 quote fields. Absent
   * for a non-quote post. (A pure boost carries `boostOf`, never `quoteOf`, and
   * federates as an `Announce` — never as a quote.)
   */
  quoteOf?: string | null;
}

/**
 * The reply addressing a Note carries when the post is a reply: the parent's
 * canonical AP object id (the Note's `inReplyTo`) plus, when the parent author is
 * resolvable, a `Mention` tag (href = author actor uri, name = `@user@domain`)
 * that Mastodon uses to thread the reply AND notify the author. Resolved by the
 * async federation caller (a DB lookup) and passed into the PURE Note builder so
 * {@link FollowService.buildCreateNoteActivity} never touches the database.
 */
export interface NoteReplyContext {
  /** Canonical AP object id of the parent post — the Note's `inReplyTo`. */
  inReplyTo: string;
  /** Parent-author addressing for the `Mention` tag + `cc` (present when resolvable). */
  mention?: { href: string; name: string };
}

/**
 * One resolved @mention of the post's declared `mentions` ids. `href` (a local
 * minted actor URL or a remote actor URI) is the authoritative resolution key for
 * both the body anchor and the `Mention` tag; `handle` (no leading `@`) is the
 * human-readable label. `isRemote` marks a federated mention (added to `cc`), and
 * `inbox` is its remote delivery inbox when known (unioned into delivery so the
 * mentioned user's instance receives + notifies the post).
 */
interface ResolvedMentionEntry {
  href: string;
  handle: string;
  isRemote: boolean;
  inbox?: string;
}

/**
 * The mention addressing a Note carries: everything resolved from the post's
 * declared `mentions` (Oxy user ids → `[mention:<id>]` placeholders in the body).
 * Resolved by the async federation caller (a batched `FederatedActor` read + one
 * bulk Oxy lookup) and passed into the PURE Note builder so
 * {@link FollowService.buildCreateNoteActivity} never touches the database.
 *
 *  - `links` feeds the linkifier: `[mention:<id>]` → a Mastodon mention anchor;
 *  - `tags` are the Note's `Mention` `tag` entries (one per resolved mention);
 *  - `cc` are the REMOTE mentioned actors' hrefs (added to the Note's `cc`);
 *  - `inboxes` are the remote delivery inboxes unioned into the follower fan-out.
 */
export interface NoteMentionContext {
  links: Map<string, ApMentionLink>;
  tags: Array<{ type: 'Mention'; href: string; name: string }>;
  cc: string[];
  inboxes: string[];
}

/**
 * The resolved poll a post carries, in the shape the AP `Question` needs — the
 * DB-read side ({@link FollowService.resolvePollContext}) yields this, and the
 * PURE Note/Question builder consumes it so {@link FollowService.buildCreateNoteActivity}
 * never touches the database. A poll post federates as a `Question` instead of a
 * `Note`; everything else about the object (attributedTo/content/url/tag/media/…)
 * is identical and shared.
 *
 *  - `multiple` picks `anyOf` (multiple-choice) vs `oneOf` (single-choice);
 *  - `options` are the poll choices with each choice's current vote count;
 *  - `endTime` is the poll deadline; `closed` says whether it has already passed
 *    (Mastodon emits `closed` only once ended, `endTime` while still open);
 *  - `votersCount` is the number of UNIQUE voters (a multiple-choice voter who
 *    picked several options counts once).
 */
export interface NotePollContext {
  multiple: boolean;
  options: Array<{ name: string; votes: number }>;
  endTime: Date;
  closed: boolean;
  votersCount: number;
}

/**
 * The quote reference a Note carries when the post quotes another post: the
 * quoted object's canonical AP object id. Resolved by the async federation caller
 * (a DB lookup reusing {@link FollowService.resolveFederationTarget}) and passed
 * into the PURE Note builder so {@link FollowService.buildCreateNoteActivity}
 * never touches the database. The one `uri` feeds every emitted quote surface —
 * the modern `quote`/`quoteUri` (FEP-044f / Mastodon 4.4+), the legacy
 * `_misskey_quote`/`quoteUrl`, and the FEP-e232 `Link` quote tag.
 */
export interface NoteQuoteContext {
  /** Canonical AP object id of the quoted post — the value of every quote field. */
  uri: string;
}

/** The Poll fields {@link buildPollContext} reads from a lean `Poll` document. */
interface PollContextSource {
  _id: unknown;
  options: Array<{ text: string; votes?: string[] }>;
  endsAt: Date;
  isMultipleChoice?: boolean;
}

/**
 * Derive a {@link NotePollContext} from a lean `Poll` document. Pure. Per-option
 * vote counts come straight off each option's `votes` set; `votersCount` is the
 * UNION of voter ids across every option (so a multiple-choice voter is counted
 * once), and `closed` is computed against the current time.
 */
function buildPollContext(poll: PollContextSource): NotePollContext {
  const voters = new Set<string>();
  const options = poll.options.map((option) => {
    let votes = 0;
    if (Array.isArray(option.votes)) {
      for (const voter of option.votes) {
        if (!voter) continue;
        votes += 1;
        voters.add(String(voter));
      }
    }
    return { name: option.text, votes };
  });

  const endTime = poll.endsAt instanceof Date ? poll.endsAt : new Date(poll.endsAt);
  return {
    multiple: poll.isMultipleChoice === true,
    options,
    endTime,
    closed: Date.now() > endTime.getTime(),
    votersCount: voters.size,
  };
}

/**
 * Turn an already-assembled AP content object (a `Note`) into a Mastodon-compatible
 * `Question` (poll), IN PLACE: flip `type`, add the option set (`oneOf`
 * single-choice / `anyOf` multiple-choice, each option a `Note` whose
 * `replies.totalItems` is its vote count), the deadline (`endTime` while open,
 * `closed` once ended), and `votersCount`. Every other field
 * (attributedTo/content/url/tag/attachment/…) is INHERITED unchanged from the
 * shared Note assembly, so Note and Question never duplicate object-building.
 */
function applyPollFields(object: Record<string, unknown>, poll: NotePollContext): void {
  object.type = 'Question';
  const optionNotes = poll.options.map((option) => ({
    type: 'Note',
    name: option.name,
    replies: { type: 'Collection', totalItems: option.votes },
  }));
  if (poll.multiple) object.anyOf = optionNotes;
  else object.oneOf = optionNotes;

  const deadline = poll.endTime.toISOString();
  if (poll.closed) object.closed = deadline;
  else object.endTime = deadline;

  object.votersCount = poll.votersCount;
}

/**
 * Assemble a per-post {@link NoteMentionContext} from the post's own declared
 * mention ids and the shared, batch-resolved id → {@link ResolvedMentionEntry}
 * map. Pure. Deduped by actor `href` so a user mentioned twice (or a mention that
 * coincides with the reply parent — deduped again in the Note builder) yields a
 * single `Mention` tag / `cc` / inbox. `links` maps EVERY declared+resolved id
 * (the linkifier keys on id, so both occurrences of a repeated mention linkify).
 */
function buildNoteMentionContext(
  ids: string[],
  entries: ReadonlyMap<string, ResolvedMentionEntry>,
): NoteMentionContext {
  const links = new Map<string, ApMentionLink>();
  const tags: Array<{ type: 'Mention'; href: string; name: string }> = [];
  const cc: string[] = [];
  const inboxes: string[] = [];
  const seenHref = new Set<string>();

  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) continue;
    if (!links.has(id)) links.set(id, { href: entry.href, handle: entry.handle });
    if (seenHref.has(entry.href)) continue;
    seenHref.add(entry.href);
    tags.push({ type: 'Mention', href: entry.href, name: `@${entry.handle}` });
    if (entry.isRemote) cc.push(entry.href);
    if (entry.inbox) inboxes.push(entry.inbox);
  }

  return { links, tags, cc, inboxes };
}

/**
 * Build the AP `contentMap`: BCP-47 tag → localized body, PRIMARY KEY FIRST.
 *
 * The primary key is inserted before the rest are walked, so it leads the map
 * unconditionally — the ordering is what Mastodon derives the status language
 * from, and it must not depend on the shape of the data. Its value is the
 * already-converted primary body (`primaryContent`), the exact string that goes
 * out as `content`, so the two can never disagree byte-for-byte.
 *
 * Every value is AP `content` HTML: each author variant's plain-text body is run
 * through {@link linkifyApHtml} (the SAME transform as the primary body) so a
 * localized body's blank lines/line breaks survive rendering AND its @mentions,
 * #hashtags and URLs linkify — and, critically, no localized variant ever ships an
 * internal `[mention:<id>]` placeholder. Only AUTHOR variants are emitted — a
 * machine translation is derived content: it is not the author's writing and it
 * does not federate.
 *
 * Returns `undefined` when the post declares no language — an UNTAGGED primary
 * variant (a body too short to detect, a remote Note that declared none) has no
 * key to sit under, and an empty map is not a legal AS2 `contentMap`. Such a post
 * federates with a body and no language claim, which is the honest thing: we
 * would otherwise be inventing a language for text nobody could identify.
 */
function buildNoteContentMap(
  post: NoteSourcePost,
  primaryTag: string | undefined,
  primaryContent: string,
  linkifyOptions: LinkifyApHtmlOptions,
): Record<string, string> | undefined {
  const contentMap: Record<string, string> = {};

  if (primaryTag) contentMap[primaryTag] = primaryContent;

  for (const variant of authorVariants(post.content)) {
    const tag = canonicalizeLanguageTag(variant.tag);
    if (tag === null || tag in contentMap) continue;
    contentMap[tag] = linkifyApHtml(variant.text, linkifyOptions);
  }

  return Object.keys(contentMap).length > 0 ? contentMap : undefined;
}

async function readResponsePreview(response: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      chunks.push(buffer);
      if (totalBytes >= DELIVERY_RESPONSE_PREVIEW_MAX_BYTES) break;
    }
  } catch {
    return '';
  } finally {
    const maybeDestroy = response as NodeJS.ReadableStream & { destroy?: () => void };
    maybeDestroy.destroy?.();
  }

  return Buffer.concat(chunks).toString('utf8', 0, DELIVERY_RESPONSE_PREVIEW_MAX_BYTES);
}

/**
 * Outbound activity delivery + follow lifecycle (Follow / Undo(Follow) /
 * Accept(Follow)) and local-post federation to remote followers.
 *
 * Extracted verbatim from the former monolithic FederationService — same behavior,
 * same signatures. Depends on ActorService (actor resolution) and the delivery
 * queue producer. `federateNewPost` remains reachable from PostCreationService
 * via the connector registry's registered PostFederator (the AP connector's
 * `deliver`).
 */
export class FollowService {
  // ============================================================
  // Activity Delivery
  // ============================================================

  /**
   * Deliver an activity to a remote inbox, signed with the sender's key.
   */
  async deliverActivity(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<boolean> {
    try {
      const { keyId } = await getPublicKey(senderUsername);
      const body = JSON.stringify(activity);
      const sigHeaders = await signRequest(keyId, 'POST', targetInbox, body);

      const allHeaders: Record<string, string> = {
        'Content-Type': AP_CONTENT_TYPE,
        'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
        'User-Agent': USER_AGENT,
        Accept: AP_CONTENT_TYPE,
        ...sigHeaders,
      };

      logger.debug(`[FedDeliver] POST ${targetInbox} body=${body} sig-headers=${sigHeaders['Signature']?.match(/headers="([^"]+)"/)?.[1]}`);

      const { response, status } = await fetchUpstreamSingleHop(targetInbox, {
        method: 'POST',
        headers: allHeaders,
        body,
        signal: AbortSignal.timeout(DELIVER_ACTIVITY_TIMEOUT_MS),
        headersTimeoutMs: DELIVER_ACTIVITY_TIMEOUT_MS,
      });

      if ((status >= 200 && status < 300) || status === 202) {
        response.destroy();
        return true;
      }

      const responseBody = await readResponsePreview(response);
      logger.debug(`Activity delivery failed to ${targetInbox}: ${status} body=${responseBody.slice(0, 500)}`);
      return false;
    } catch (err) {
      logger.debug(`Activity delivery error to ${targetInbox}:`, err);
      return false;
    }
  }

  /**
   * Queue an activity for delivery (with retries).
   *
   * Durable path: enqueue onto the BullMQ delivery queue (deduped per
   * targetInbox + activity id). When the queue is unavailable (Redis not
   * configured) fall back to the Mongo delivery queue, which the in-process
   * scheduler retries. Either way the delivery is never lost.
   */
  async queueDelivery(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
  ): Promise<void> {
    // Defense-in-depth: never enqueue a durable delivery to an unsafe inbox
    // URL. The per-send fetch in `deliverActivity` is already SSRF-pinned, but
    // a blocked URL would otherwise sit in the queue and be retried forever.
    const guard = await assertSafePublicUrl(targetInbox);
    if (!guard.ok) {
      logger.warn(`[FedDeliver] not queueing unsafe inbox URL ${targetInbox}: ${guard.reason}`);
      return;
    }

    const enqueued = await enqueueDelivery({
      activityJson: activity,
      targetInbox,
      senderOxyUserId,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FedDeliver] enqueue failed for ${targetInbox}, falling back to Mongo: ${message}`);
      return false;
    });

    if (enqueued) return;

    await FederationDeliveryQueue.create({
      activityJson: activity,
      targetInbox,
      senderOxyUserId,
      nextAttemptAt: new Date(),
    });
  }

  /**
   * Resolve a remote AP actor's delivery inbox (shared inbox preferred) from the
   * stored `FederatedActor` row — the SAME source the follower fan-out below and
   * the inbound ingest side read, so an inbox unioned in via `extraInboxes`
   * dedupes cleanly against the follower set. Returns undefined when the actor is
   * unknown locally or carries no inbox (e.g. an atproto-only actor).
   *
   * General-purpose by design: the standalone inbox resolver for a caller that
   * holds only an actor uri (e.g. a Like target's author in Part 3).
   * {@link resolveFederationTarget} does its OWN single actor read instead, because
   * it needs the acct (`user@domain`) off the same row for a reply's `Mention`
   * name, and a shared string-only helper would force a second query for it.
   */
  async resolveActorInbox(actorUri: string | undefined): Promise<string | undefined> {
    if (!actorUri) return undefined;
    const actor = await FederatedActor.findOne({ uri: actorUri }).lean();
    if (!actor) return undefined;
    return actor.sharedInboxUrl ?? actor.inboxUrl ?? undefined;
  }

  /**
   * Deliver an activity to all remote followers of a local user, plus any
   * EXPLICIT remote inboxes passed in `options.extraInboxes` (e.g. the boosted
   * original's author inbox, a reply parent's author inbox). Deliveries are
   * grouped by shared inbox so an instance is never POSTed the same activity
   * twice — an explicit inbox that coincides with a follower's shared inbox is
   * delivered exactly once.
   */
  async deliverToFollowers(
    activity: Record<string, unknown>,
    senderOxyUserId: string,
    senderUsername: string,
    options: { extraInboxes?: string[] } = {},
  ): Promise<void> {
    const follows = await FederatedFollow.find({
      localUserId: senderOxyUserId,
      direction: 'inbound',
      status: 'accepted',
    }).lean();

    const actorUris = follows.map((f) => f.remoteActorUri);
    const actors = actorUris.length > 0
      ? await FederatedActor.find({ uri: { $in: actorUris } }).lean()
      : [];

    // Group by shared inbox to avoid duplicate deliveries. Follower inboxes
    // first, then the explicit targets — the shared `seen` set dedupes an
    // explicit inbox that an instance already receives as a follower.
    const seen = new Set<string>();
    const inboxes: string[] = [];
    for (const actor of actors) {
      const inbox = actor.sharedInboxUrl || actor.inboxUrl;
      if (inbox && !seen.has(inbox)) {
        seen.add(inbox);
        inboxes.push(inbox);
      }
    }
    for (const inbox of options.extraInboxes ?? []) {
      if (inbox && !seen.has(inbox)) {
        seen.add(inbox);
        inboxes.push(inbox);
      }
    }
    if (inboxes.length === 0) return;

    // Durable path: enqueue one BullMQ delivery per shared inbox (deduped per
    // inbox + activity id). When the queue is unavailable fall back to a single
    // Mongo batch insert for the inboxes that were not enqueued.
    const now = new Date();
    const mongoFallback: Array<{
      activityJson: Record<string, unknown>;
      targetInbox: string;
      senderOxyUserId: string;
      nextAttemptAt: Date;
    }> = [];

    for (const inbox of inboxes) {
      const enqueued = await enqueueDelivery({
        activityJson: activity,
        targetInbox: inbox,
        senderOxyUserId,
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedDeliver] follower enqueue failed for ${inbox}, falling back to Mongo: ${message}`);
        return false;
      });

      if (!enqueued) {
        mongoFallback.push({ activityJson: activity, targetInbox: inbox, senderOxyUserId, nextAttemptAt: now });
      }
    }

    if (mongoFallback.length > 0) {
      await FederationDeliveryQueue.insertMany(mongoFallback, { ordered: false });
    }
  }

  /**
   * Convert a local Mention post to an ActivityPub Create(Note) activity.
   *
   * The SINGLE Note builder shared by push delivery (`federateNewPost`), the
   * outbox page, and the per-post dereference route so every surface Mastodon
   * reads carries the same fidelity: canonical post URL, hashtag `tag`s, media
   * `attachment`s (built via the canonical media chokepoint, fail-soft), and the
   * post's language.
   *
   * LANGUAGE — `content` + `contentMap` + `language`:
   *
   * A Mastodon-compatible status carries ONE body. `content` is the primary
   * body; `contentMap` is a map of BCP-47 tag → localized body, which Mastodon
   * only reads as a FALLBACK when `content` is missing (`status_parser.rb`). So a
   * multilingual Mention post federates as its PRIMARY body plus the full map —
   * never as two rendered bodies.
   *
   * The map's KEY ORDER is load-bearing: Mastodon takes the status's language
   * from `contentMap.keys.first`. The primary tag is therefore emitted first, or
   * the status is labelled with the wrong language. Emitting a SINGLE-key map for
   * a monolingual post is not redundant — it is the only way Mastodon learns the
   * language at all.
   *
   * The body is RESOLVED from the post's primary variant here, at read time.
   * There is no stored copy of it to read instead: AP's single `content` slot is
   * a wire format, not a reason to denormalize storage.
   *
   * Media is a single AP `attachment` set, so it is the PRIMARY rendition's media
   * (the shared set, or that variant's override, with its alt text already
   * localized by the resolver). A non-primary variant's media override is
   * internal to Mention — there is nowhere in AS2 to put a second attachment set.
   */
  buildCreateNoteActivity(
    post: NoteSourcePost,
    username: string,
    reply?: NoteReplyContext,
    mentions?: NoteMentionContext,
    poll?: NotePollContext,
    quote?: NoteQuoteContext,
  ): Record<string, unknown> {
    const actor = actorUrl(username);
    const postId = String(post._id);
    const noteId = `${actor}/posts/${postId}`;
    // Emit a canonical ISO 8601 `published` regardless of whether the caller
    // passed a Mongoose `Date` (outbox/dereference) or an ISO string (push).
    const published = post.createdAt instanceof Date ? post.createdAt.toISOString() : post.createdAt;

    const tags: Array<Record<string, string>> = [];
    if (post.hashtags) {
      for (const tag of post.hashtags) {
        tags.push({ type: 'Hashtag', href: hashtagUrl(tag), name: `#${tag}` });
      }
    }
    // `Mention` tags: the reply-parent author (threads + notifies) PLUS every
    // @mentioned user. `href` (the actor uri) is the authoritative resolution key;
    // `name` (`@user` / `@user@domain`) is the human-readable handle. Deduped by
    // href so a parent author who is ALSO @mentioned yields a single tag.
    const seenMentionHref = new Set<string>();
    const pushMentionTag = (href: string, name: string): void => {
      if (!href || seenMentionHref.has(href)) return;
      seenMentionHref.add(href);
      tags.push({ type: 'Mention', href, name });
    };
    if (reply?.mention) pushMentionTag(reply.mention.href, reply.mention.name);
    if (mentions) {
      for (const tag of mentions.tags) pushMentionTag(tag.href, tag.name);
    }
    // FEP-e232 quote `Link` tag: a machine-readable pointer to the quoted object
    // (`mediaType: application/activity+json`) so a quote-aware server (Mastodon
    // 4.4+/Misskey) renders the inline quote. Emitted only for a real quote post —
    // a boost never reaches this Create builder.
    if (quote) {
      tags.push({
        type: 'Link',
        mediaType: AP_CONTENT_TYPE,
        href: quote.uri,
        name: `RE: ${quote.uri}`,
        rel: 'https://misskey-hub.net/ns#_misskey_quote',
      });
    }

    // The primary rendition: its body, its media (shared or overridden, alt
    // localized) and the tag it is written in — all from the one resolver.
    const primary = resolveVariant(post.content);

    const attachments = Array.isArray(primary.media)
      ? primary.media
          .map(buildNoteAttachment)
          .filter((a): a is Record<string, unknown> => a !== undefined)
      : [];

    // AP `content` is HTML: linkify the resolved plain-text primary body ONCE
    // (@mentions/#hashtags/URLs → anchors, internal placeholders resolved) and
    // thread the result through both `content` and the primary `contentMap` key so
    // they stay byte-for-byte identical (Mastodon reads `content` and only falls
    // back to `contentMap`, but the two must never disagree). Both go through the
    // SAME linkify options so every rendition resolves mentions identically.
    const linkifyOptions: LinkifyApHtmlOptions = {
      mentions: mentions?.links,
      hashtagHref: (tag) => hashtagUrl(normalizeHashtag(tag)),
    };
    const primaryContent = linkifyApHtml(primary.text, linkifyOptions);
    const language = canonicalizeLanguageTag(primary.tag) ?? undefined;
    const contentMap = buildNoteContentMap(post, language, primaryContent, linkifyOptions);

    // The author's sensitive/NSFW flag → AP `sensitive` so a compatible instance
    // blurs the media / hides the body behind a content-warning click. Boolean
    // only: there is no CW TEXT to emit as `summary`.
    const sensitive = post.metadata?.isSensitive === true;
    // AP `source`: the RAW plaintext primary body (the same value linkified into
    // `content` above). Now that `content` is HTML, Mastodon uses `source.content`
    // for edit-fetch fidelity. Omitted for an empty body (e.g. a boost — which
    // never reaches this Create path anyway).
    const source = primary.text
      ? { content: primary.text, mediaType: 'text/plain' }
      : undefined;

    // The public collection stays in `to`; the mentioned parent author + every
    // REMOTE @mentioned actor join the followers collection in `cc` so a public
    // reply/mention is delivered/attributed to them (mirrors how the boost path
    // cc's the boosted author). Deduped, same set on the Create envelope + Note.
    const cc = [`${actor}/followers`];
    const seenCc = new Set(cc);
    const pushCc = (href: string): void => {
      if (!href || seenCc.has(href)) return;
      seenCc.add(href);
      cc.push(href);
    };
    if (reply?.mention) pushCc(reply.mention.href);
    if (mentions) {
      for (const href of mentions.cc) pushCc(href);
    }

    // The shared content object. A plain post serializes it as a `Note`; a poll
    // post reuses this EXACT object and only adds the poll structure + flips
    // `type` to `Question` (see {@link applyPollFields}), so Note and Question
    // never duplicate the attributedTo/content/url/tag/attachment assembly.
    const object: Record<string, unknown> = {
      id: noteId,
      type: 'Note',
      attributedTo: actor,
      // Only present on a reply — undefined is dropped by JSON serialization,
      // so a top-level Note carries no `inReplyTo`.
      inReplyTo: reply?.inReplyTo,
      // Quote reference — the quoted object's canonical AP id under both the
      // modern (`quote`/`quoteUri`, FEP-044f / Mastodon 4.4+) and legacy
      // (`_misskey_quote`/`quoteUrl`, Misskey/Pleroma) terms so a quote-aware
      // server renders the inline quote. Structured fields ONLY — the quoted URL
      // is deliberately NOT appended to `content` (that would double-render). All
      // undefined (dropped by JSON) for a non-quote post; the matching FEP-e232
      // `Link` tag is added to `tag` above.
      quote: quote?.uri,
      quoteUri: quote?.uri,
      quoteUrl: quote?.uri,
      _misskey_quote: quote?.uri,
      url: `https://${FEDERATION_DOMAIN}/@${username}/posts/${postId}`,
      sensitive,
      content: primaryContent,
      contentMap,
      // Raw plaintext body, omitted (undefined dropped by JSON serialization)
      // when the post has no body.
      source,
      language,
      published,
      to: [AP_PUBLIC],
      cc,
      tag: tags.length > 0 ? tags : undefined,
      attachment: attachments.length > 0 ? attachments : undefined,
    };

    if (poll) applyPollFields(object, poll);

    return {
      '@context': AP_CONTEXT,
      id: `${noteId}/activity`,
      type: 'Create',
      actor,
      published,
      to: [AP_PUBLIC],
      cc,
      object,
    };
  }

  /**
   * Federate a newly created local post to all remote followers.
   */
  async federateNewPost(
    post: NoteSourcePost & { visibility: string },
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    // Defensive: the `ConnectorRegistry` outbound seam already gates every
    // event on `fediverseSharing` before it reaches a connector. This
    // duplicate check protects any other caller that might reach
    // `federateNewPost` directly, bypassing the registry.
    if (!(await isFediverseSharingEnabled(senderOxyUserId))) return;

    // A boost carries an intentionally EMPTY body. It must NEVER federate as a
    // `Create(Note)` — that would push a blank status to every remote follower.
    // Route it to the `Announce` path instead. (A QUOTE post has a real body AND
    // a `quoteOf`, no `boostOf`, so it correctly falls through to the Create path
    // below and federates as a normal Note.)
    if (post.boostOf) {
      await this.federateBoost(
        { _id: post._id, boostOf: String(post.boostOf), createdAt: post.createdAt },
        senderOxyUserId,
        senderUsername,
      );
      return;
    }

    if (post.visibility !== PostVisibility.PUBLIC) return;

    try {
      // A reply carries `inReplyTo` + a parent-author `Mention`, and is ALSO
      // delivered to the parent author's inbox (federated parent only) so their
      // instance threads + notifies it. Fail-soft: an unresolvable parent yields
      // `null`, so the Note federates as a normal post (no `inReplyTo`) rather
      // than being dropped.
      const reply = await this.resolveReplyDelivery(post);
      // The post's @mentions: resolved to mention anchors + `Mention` tags, and —
      // for REMOTE mentioned users — their inboxes are unioned into delivery so
      // their instance receives + notifies the post. `null` when the post mentions
      // nobody; the linkifier still strips any stray placeholder.
      const mentions = await this.resolveMentionContext(post);
      // A poll post federates as a `Question` (options + current tallies); a
      // non-poll post resolves to null and federates as a plain Note.
      const poll = await this.resolvePollContext(post);
      // A quote post carries the quoted object's canonical AP id in the quote
      // fields (+ FEP-e232 Link tag); a non-quote post resolves to null. Fail-soft:
      // an unresolvable quoted post federates the commentary without quote fields.
      const quote = await this.resolveQuoteContext(post);
      const activity = this.buildCreateNoteActivity(post, senderUsername, reply?.context, mentions ?? undefined, poll ?? undefined, quote ?? undefined);
      await this.deliverToFollowers(activity, senderOxyUserId, senderUsername, {
        extraInboxes: [
          ...(reply?.parentAuthorInbox ? [reply.parentAuthorInbox] : []),
          ...(mentions?.inboxes ?? []),
        ],
      });
    } catch (err) {
      logger.error('Failed to federate new post:', err);
    }
  }

  /**
   * Build the reply `Mention` (`href` = parent author actor uri, `name` =
   * `@<acct>`) from a resolved {@link FederationTarget}. Shared by the push and
   * pull surfaces so the tag is identical everywhere. The mention is omitted when
   * the author cannot be resolved to both an actor uri and an acct — the Note
   * still carries `inReplyTo`, which is enough for threading.
   */
  private buildReplyContextFromTarget(target: FederationTarget): NoteReplyContext {
    const mention =
      target.authorActorUri && target.authorAcct
        ? { href: target.authorActorUri, name: `@${target.authorAcct}` }
        : undefined;
    return { inReplyTo: target.objectUri, mention };
  }

  /**
   * Resolve a post's reply addressing for the PULL surfaces (the per-post
   * dereference route serving a Note without delivering it): the `inReplyTo` +
   * parent-author `Mention`. Returns null when the post is not a reply OR the
   * parent cannot be resolved. Fail-soft — any error resolves to null (the Note
   * is served without `inReplyTo` rather than 500ing), so a caller never needs
   * its own try/catch.
   */
  async resolveReplyContext(post: NoteSourcePost): Promise<NoteReplyContext | null> {
    const parentId = post.parentPostId ? String(post.parentPostId) : undefined;
    if (!parentId) return null;
    try {
      const target = await this.resolveFederationTarget(parentId);
      if (!target) return null;
      return this.buildReplyContextFromTarget(target);
    } catch (err) {
      logger.warn(`[FedDeliver] failed to resolve reply context for parent ${parentId}:`, err);
      return null;
    }
  }

  /**
   * Resolve a post's reply addressing for the PUSH path — the reply Note's
   * {@link NoteReplyContext} PLUS the parent author's remote inbox to union into
   * delivery. The inbox is set only for a FEDERATED parent (a local parent's
   * author is one of us, reached through their own followers, never a remote
   * POST), so a reply to a local post adds no bogus extra inbox. Fail-soft: not a
   * reply or unresolvable parent → null (federates as a normal post).
   */
  private async resolveReplyDelivery(
    post: NoteSourcePost,
  ): Promise<{ context: NoteReplyContext; parentAuthorInbox?: string } | null> {
    const parentId = post.parentPostId ? String(post.parentPostId) : undefined;
    if (!parentId) return null;
    try {
      const target = await this.resolveFederationTarget(parentId);
      if (!target) return null;
      return {
        context: this.buildReplyContextFromTarget(target),
        parentAuthorInbox: target.authorInbox,
      };
    } catch (err) {
      logger.warn(`[FedDeliver] failed to resolve reply delivery for parent ${parentId}:`, err);
      return null;
    }
  }

  /**
   * Resolve a set of mentioned Oxy user ids to their per-mention addressing
   * ({@link ResolvedMentionEntry}) in AT MOST two batched reads — no N+1 per
   * mention:
   *
   *  1. ONE {@link FederatedActor} query resolves every FEDERATED mention at once,
   *     yielding its actor URI (`href`), `acct` (`user@domain` handle) AND the
   *     delivery inbox from the same row.
   *  2. The remaining ids are LOCAL Oxy users (or a federated user whose actor row
   *     is momentarily missing); ONE bulk `getUsersByIds` resolves their canonical
   *     handle. A local user → our minted actor URL + bare `username`; a federated
   *     user with a known `federation.actorUri` → that URI + `user@domain` (no
   *     inbox, so tag/cc only).
   *
   * Fail-soft: an unresolvable id is simply absent from the map (the linkifier
   * then DROPS its placeholder — never leaks `[mention:<id>]`). A degraded Oxy
   * user (empty handle) is treated as unresolved. Best-effort — a lookup error is
   * logged and yields no entries for that batch rather than throwing.
   */
  private async resolveMentionEntries(ids: string[]): Promise<Map<string, ResolvedMentionEntry>> {
    const entries = new Map<string, ResolvedMentionEntry>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return entries;

    // 1. Federated mentions — one read gives href (actor uri), handle (acct) and
    //    the delivery inbox.
    let federatedActors: Array<
      Pick<IFederatedActor, 'oxyUserId' | 'uri' | 'acct' | 'sharedInboxUrl' | 'inboxUrl'>
    > = [];
    try {
      federatedActors = await FederatedActor.find({ oxyUserId: { $in: unique } })
        .select('oxyUserId uri acct sharedInboxUrl inboxUrl')
        .lean<Array<Pick<IFederatedActor, 'oxyUserId' | 'uri' | 'acct' | 'sharedInboxUrl' | 'inboxUrl'>>>();
    } catch (err) {
      logger.warn('[FedDeliver] mention federated-actor lookup failed', {
        count: unique.length,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }

    const federatedIds = new Set<string>();
    for (const actor of federatedActors) {
      const id = actor.oxyUserId ? String(actor.oxyUserId) : '';
      if (!id || !actor.uri || !actor.acct) continue;
      federatedIds.add(id);
      entries.set(id, {
        href: actor.uri,
        handle: actor.acct,
        isRemote: true,
        inbox: actor.sharedInboxUrl ?? actor.inboxUrl ?? undefined,
      });
    }

    // 2. The rest are local (or federated-without-a-row) — one bulk Oxy lookup.
    const localIds = unique.filter((id) => !federatedIds.has(id));
    if (localIds.length === 0) return entries;

    let users: OxyUser[] = [];
    try {
      users = await getServiceOxyClient().getUsersByIds(localIds);
    } catch (err) {
      logger.warn('[FedDeliver] mention Oxy user lookup failed', {
        count: localIds.length,
        reason: err instanceof Error ? err.message : 'unknown',
      });
      return entries;
    }

    for (const user of users) {
      const id = String(user.id ?? '');
      if (!id) continue;
      // Canonical handle: `username` (local) or `username@domain` (federated). An
      // empty handle is a degraded/unresolved user — drop it, never emit a ghost.
      const handle = getNormalizedUserHandle(user);
      if (!handle) continue;
      const isRemote = user.type === 'federated' || user.isFederated === true;
      const href = isRemote
        ? (typeof user.federation?.actorUri === 'string' && user.federation.actorUri.length > 0
            ? user.federation.actorUri
            : undefined)
        : actorUrl(handle);
      if (!href) continue; // federated user with no resolvable actor uri → drop.
      entries.set(id, { href, handle, isRemote });
    }

    return entries;
  }

  /**
   * Batch-resolve the {@link NoteMentionContext} for MANY posts by the same author
   * (the outbox page / featured collection) in the SAME two batched reads a single
   * post costs — the union of every post's declared mention ids is resolved once,
   * then each post's context is assembled from the shared id → entry map. A post
   * that mentions nobody (or whose mentions all fail to resolve) is absent from the
   * returned map; the Note builder then simply linkifies without a mention context.
   */
  async resolveMentionContextByPost(posts: NoteSourcePost[]): Promise<Map<string, NoteMentionContext>> {
    const result = new Map<string, NoteMentionContext>();
    const perPostIds = new Map<string, string[]>();
    const allIds: string[] = [];

    for (const post of posts) {
      const ids = normalizeMentionIds(post.mentions);
      if (ids.length === 0) continue;
      perPostIds.set(String(post._id), ids);
      allIds.push(...ids);
    }
    if (allIds.length === 0) return result;

    const entries = await this.resolveMentionEntries(allIds);
    for (const [postId, ids] of perPostIds) {
      const context = buildNoteMentionContext(ids, entries);
      if (context.links.size > 0) result.set(postId, context);
    }
    return result;
  }

  /**
   * Resolve a single post's {@link NoteMentionContext} — the push-delivery and
   * per-post dereference entry point. Returns null when the post mentions nobody
   * or nothing resolves (the linkifier still strips any stray placeholder). Never
   * throws — {@link resolveMentionEntries} is fail-soft.
   */
  async resolveMentionContext(post: NoteSourcePost): Promise<NoteMentionContext | null> {
    const ids = normalizeMentionIds(post.mentions);
    if (ids.length === 0) return null;
    const entries = await this.resolveMentionEntries(ids);
    const context = buildNoteMentionContext(ids, entries);
    return context.links.size > 0 ? context : null;
  }

  /**
   * Resolve a single post's {@link NotePollContext} — the push-delivery and
   * per-post dereference entry point. A poll post links to its `Poll` document by
   * `content.pollId`; this reads that document and derives the AP `Question`
   * fields (options + per-option vote counts, deadline, unique voters). Returns
   * null when the post carries no poll or the poll document is gone (the post then
   * federates as a plain Note). Fail-soft: a read error is logged and resolves to
   * null rather than breaking delivery.
   */
  async resolvePollContext(post: NoteSourcePost): Promise<NotePollContext | null> {
    const pollId = post.content?.pollId;
    if (!pollId) return null;
    try {
      const poll = await Poll.findById(pollId)
        .select('options endsAt isMultipleChoice')
        .lean<PollContextSource | null>();
      return poll ? buildPollContext(poll) : null;
    } catch (err) {
      logger.warn(`[FedDeliver] failed to resolve poll context for post ${String(post._id)}:`, err);
      return null;
    }
  }

  /**
   * Batch-resolve the {@link NotePollContext} for MANY posts (the outbox page /
   * featured collection) in ONE `Poll` read — the union of every post's `pollId`
   * is fetched at once, then each post that has one is keyed to its context. A
   * post without a poll (or whose poll is gone) is absent from the map; the Note
   * builder then serializes it as a plain Note. Fail-soft: a read error logs and
   * yields an empty map.
   */
  async resolvePollContextByPost(posts: NoteSourcePost[]): Promise<Map<string, NotePollContext>> {
    const result = new Map<string, NotePollContext>();
    const pollIdToPostIds = new Map<string, string[]>();

    for (const post of posts) {
      const pollId = post.content?.pollId;
      if (!pollId) continue;
      const key = String(pollId);
      const bucket = pollIdToPostIds.get(key);
      if (bucket) bucket.push(String(post._id));
      else pollIdToPostIds.set(key, [String(post._id)]);
    }
    if (pollIdToPostIds.size === 0) return result;

    try {
      const polls = await Poll.find({ _id: { $in: [...pollIdToPostIds.keys()] } })
        .select('options endsAt isMultipleChoice')
        .lean<PollContextSource[]>();
      for (const poll of polls) {
        const postIds = pollIdToPostIds.get(String(poll._id));
        if (!postIds) continue;
        const context = buildPollContext(poll);
        for (const postId of postIds) result.set(postId, context);
      }
    } catch (err) {
      logger.warn('[FedDeliver] batch poll-context resolution failed', {
        count: pollIdToPostIds.size,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
    return result;
  }

  /**
   * Resolve a single post's {@link NoteQuoteContext} — the push-delivery, edit
   * and per-post dereference entry point. A quote post links to the quoted post by
   * `quoteOf`; this reuses {@link resolveFederationTarget} to turn that local id
   * into the quoted object's canonical AP object uri (a federated quoted post →
   * its remote `federation.activityId`; a local quoted post → its minted
   * `/ap/users/<owner>/posts/<id>` uri). Returns null when the post is not a quote
   * OR the quoted post is unresolvable — the post then federates as a normal Note
   * carrying its own commentary, just without the quote fields. Fail-soft: any
   * error is logged and resolves to null rather than breaking delivery.
   */
  async resolveQuoteContext(post: NoteSourcePost): Promise<NoteQuoteContext | null> {
    const quoteId = post.quoteOf ? String(post.quoteOf) : undefined;
    if (!quoteId) return null;
    try {
      const target = await this.resolveFederationTarget(quoteId);
      return target ? { uri: target.objectUri } : null;
    } catch (err) {
      logger.warn(`[FedDeliver] failed to resolve quote context for quoted post ${quoteId}:`, err);
      return null;
    }
  }

  /**
   * Batch-resolve the {@link NoteQuoteContext} for MANY posts (the outbox page /
   * featured collection). The unique set of quoted post ids is resolved once each —
   * reusing {@link resolveFederationTarget}, in parallel and deduped so two posts
   * quoting the same original share one resolution — then each quote post is keyed
   * to its context. A non-quote post (or one whose quoted post is unresolvable) is
   * absent from the map; the Note builder then serializes it without quote fields.
   * Fail-soft per quoted post: a resolution error logs and yields no entry.
   */
  async resolveQuoteContextByPost(posts: NoteSourcePost[]): Promise<Map<string, NoteQuoteContext>> {
    const result = new Map<string, NoteQuoteContext>();
    const quoteIdToPostIds = new Map<string, string[]>();

    for (const post of posts) {
      const quoteId = post.quoteOf ? String(post.quoteOf) : undefined;
      if (!quoteId) continue;
      const postId = String(post._id);
      const bucket = quoteIdToPostIds.get(quoteId);
      if (bucket) bucket.push(postId);
      else quoteIdToPostIds.set(quoteId, [postId]);
    }
    if (quoteIdToPostIds.size === 0) return result;

    await Promise.all(
      [...quoteIdToPostIds.entries()].map(async ([quoteId, postIds]) => {
        let target: FederationTarget | null = null;
        try {
          target = await this.resolveFederationTarget(quoteId);
        } catch (err) {
          logger.warn(`[FedDeliver] failed to resolve quote context for quoted post ${quoteId}:`, err);
          return;
        }
        if (!target) return;
        for (const postId of postIds) result.set(postId, { uri: target.objectUri });
      }),
    );
    return result;
  }

  /**
   * Resolve the canonical ActivityPub object id of a boosted/replied/liked
   * ORIGINAL post (plus, for a federated original, its author's remote inbox).
   *
   *  - FEDERATED original → the remote `federation.activityId` IS its canonical
   *    AP id; the author's inbox is resolved from the stored `FederatedActor`.
   *  - LOCAL original → we mint our own note URI
   *    `https://<domain>/ap/users/<owner-username>/posts/<postId>` (the exact id
   *    `buildCreateNoteActivity` / the outbox / the per-post dereference route
   *    advertise), so a remote server can dereference it. The owner username is
   *    resolved server-side from the authoritative `oxyUserId`; there is no
   *    remote inbox (the author is local).
   *
   * Returns null when the original is missing or its author cannot be resolved.
   */
  private async resolveFederationTarget(originalPostId: string): Promise<FederationTarget | null> {
    const original = await Post.findById(originalPostId).select('oxyUserId federation').lean();
    if (!original) return null;

    const activityId = original.federation?.activityId;
    if (activityId) {
      const authorActorUri = original.federation?.actorUri;
      // ONE actor read yields both the delivery inbox and the acct (`user@domain`)
      // a reply's `Mention` name is built from — the same `FederatedActor` row
      // `resolveActorInbox` reads. (`resolveActorInbox` remains the standalone
      // inbox resolver for callers that have only an actor uri.)
      const actor = authorActorUri
        ? await FederatedActor.findOne({ uri: authorActorUri }).lean()
        : null;
      return {
        objectUri: activityId,
        authorActorUri,
        authorInbox: actor?.sharedInboxUrl ?? actor?.inboxUrl ?? undefined,
        authorAcct: actor?.acct ?? undefined,
      };
    }

    const ownerId = original.oxyUserId ? String(original.oxyUserId) : undefined;
    if (!ownerId) return null;
    let ownerUsername: string | undefined;
    try {
      const owner = await getServiceOxyClient().getUserById(ownerId);
      ownerUsername = owner.username?.trim() || undefined;
    } catch (err) {
      logger.warn(`[FedDeliver] failed to resolve original author username for post ${originalPostId}:`, err);
      return null;
    }
    if (!ownerUsername) return null;

    const authorActorUri = actorUrl(ownerUsername);
    return {
      objectUri: `${authorActorUri}/posts/${originalPostId}`,
      authorActorUri,
      authorAcct: `${ownerUsername}@${FEDERATION_DOMAIN}`,
    };
  }

  /**
   * Build an `Announce` (boost) activity for a local booster of `objectUri`.
   * Addressed to the public collection, `cc`'d to the booster's followers and
   * (when known) the original author's actor URI. The activity id is minted
   * deterministically from the boost's local `_id` so `Undo(Announce)` can
   * reference the same id without persisting it.
   */
  buildAnnounceActivity(
    boosterUsername: string,
    boostId: string,
    objectUri: string,
    originalAuthorActorUri: string | undefined,
    published: string | Date,
  ): Record<string, unknown> {
    const actor = actorUrl(boosterUsername);
    const cc = [`${actor}/followers`];
    if (originalAuthorActorUri) cc.push(originalAuthorActorUri);
    return {
      '@context': AP_CONTEXT,
      id: `${actor}/boosts/${boostId}`,
      type: 'Announce',
      actor,
      object: objectUri,
      published: published instanceof Date ? published.toISOString() : published,
      to: [AP_PUBLIC],
      cc,
    };
  }

  /**
   * Build the matching `Undo(Announce)` for an unboost. The embedded `Announce`
   * re-mints the SAME id + addressing `buildAnnounceActivity` emitted so remote
   * servers can retract the exact boost.
   */
  buildUndoAnnounceActivity(
    boosterUsername: string,
    boostId: string,
    objectUri: string,
    originalAuthorActorUri: string | undefined,
  ): Record<string, unknown> {
    const actor = actorUrl(boosterUsername);
    const cc = [`${actor}/followers`];
    if (originalAuthorActorUri) cc.push(originalAuthorActorUri);
    const announceId = `${actor}/boosts/${boostId}`;
    return {
      '@context': AP_CONTEXT,
      id: `${announceId}/undo`,
      type: 'Undo',
      actor,
      to: [AP_PUBLIC],
      cc,
      object: {
        id: announceId,
        type: 'Announce',
        actor,
        object: objectUri,
        to: [AP_PUBLIC],
        cc,
      },
    };
  }

  /**
   * Federate a local user's boost as an `Announce`. Delivered to the booster's
   * remote followers AND — when the boosted original is federated — the original
   * author's inbox (so their instance records the boost), deduped by the shared
   * addressing helper. Boosts of purely-local content still reach the booster's
   * remote followers so their Mastodon timeline shows the boost.
   *
   * Gated identically to {@link federateNewPost}: local booster, sharing on.
   * Best-effort — a failure never surfaces to the caller.
   */
  async federateBoost(
    boost: LocalBoostEventPayload,
    boosterOxyUserId: string,
    boosterUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    if (!(await isFediverseSharingEnabled(boosterOxyUserId))) return;
    const boostOf = boost.boostOf ? String(boost.boostOf) : undefined;
    if (!boostOf) return;

    try {
      const target = await this.resolveFederationTarget(boostOf);
      if (!target) {
        logger.warn(`[FedDeliver] cannot federate boost ${String(boost._id)}: unresolved original ${boostOf}`);
        return;
      }
      const activity = this.buildAnnounceActivity(
        boosterUsername,
        String(boost._id),
        target.objectUri,
        target.authorActorUri,
        boost.createdAt,
      );
      await this.deliverToFollowers(activity, boosterOxyUserId, boosterUsername, {
        extraInboxes: target.authorInbox ? [target.authorInbox] : [],
      });
    } catch (err) {
      logger.error('Failed to federate boost:', err);
    }
  }

  /**
   * Federate an unboost as an `Undo(Announce)`. Same addressing as
   * {@link federateBoost}. The caller must invoke this with the boost's data
   * still available (before or right after deleting the local boost row); the
   * ORIGINAL post is untouched by an unboost, so target resolution still works.
   */
  async federateUndoBoost(
    boost: LocalBoostEventPayload,
    boosterOxyUserId: string,
    boosterUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    if (!(await isFediverseSharingEnabled(boosterOxyUserId))) return;
    const boostOf = boost.boostOf ? String(boost.boostOf) : undefined;
    if (!boostOf) return;

    try {
      const target = await this.resolveFederationTarget(boostOf);
      if (!target) {
        logger.warn(`[FedDeliver] cannot federate unboost ${String(boost._id)}: unresolved original ${boostOf}`);
        return;
      }
      const activity = this.buildUndoAnnounceActivity(
        boosterUsername,
        String(boost._id),
        target.objectUri,
        target.authorActorUri,
      );
      await this.deliverToFollowers(activity, boosterOxyUserId, boosterUsername, {
        extraInboxes: target.authorInbox ? [target.authorInbox] : [],
      });
    } catch (err) {
      logger.error('Failed to federate unboost:', err);
    }
  }

  /**
   * Build a `Delete(Tombstone)` for a deleted local post. `object` is a minimal
   * `Tombstone` carrying only the deleted Note's canonical AP id — the exact id
   * `buildCreateNoteActivity` / the outbox / the dereference route advertised, so a
   * remote server matches it to the status it holds and removes it. Addressed to
   * the public collection, `cc`'d to the deleter's followers.
   */
  buildDeleteActivity(username: string, postId: string): Record<string, unknown> {
    const actor = actorUrl(username);
    const noteId = `${actor}/posts/${postId}`;
    return {
      '@context': AP_CONTEXT,
      id: `${noteId}/delete`,
      type: 'Delete',
      actor,
      to: [AP_PUBLIC],
      cc: [`${actor}/followers`],
      object: {
        id: noteId,
        type: 'Tombstone',
      },
    };
  }

  /**
   * Federate a local post deletion as a `Delete(Tombstone)` to the deleter's
   * remote followers. The post row is already gone — the caller captures the id
   * BEFORE deletion — but the canonical Note id is minted purely from the
   * username + post id, so nothing needs the row. Gated identically to
   * {@link federateNewPost}; best-effort.
   */
  async federateDelete(
    post: { _id: unknown },
    deleterOxyUserId: string,
    deleterUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    if (!(await isFediverseSharingEnabled(deleterOxyUserId))) return;

    try {
      const activity = this.buildDeleteActivity(deleterUsername, String(post._id));
      await this.deliverToFollowers(activity, deleterOxyUserId, deleterUsername);
    } catch (err) {
      logger.error('Failed to federate post delete:', err);
    }
  }

  /**
   * Build an `Update(Note)` for an edited local post. The embedded object is the
   * SAME Note {@link buildCreateNoteActivity} builds (canonical body, hashtags,
   * media, and — for a reply — `inReplyTo` + the parent-author `Mention`) PLUS an
   * `updated` timestamp, which is how Mastodon marks a status as edited. The
   * envelope mirrors the Note's `to`/`cc` so the edit reaches the same audience as
   * the original.
   */
  buildUpdateNoteActivity(
    post: NoteSourcePost,
    username: string,
    reply?: NoteReplyContext,
    mentions?: NoteMentionContext,
    poll?: NotePollContext,
    quote?: NoteQuoteContext,
  ): Record<string, unknown> {
    const created = this.buildCreateNoteActivity(post, username, reply, mentions, poll, quote);
    const note = created.object as Record<string, unknown>;

    const now = new Date();
    const updated = now.toISOString();
    const noteId = String(note.id);
    const actor = actorUrl(username);

    return {
      '@context': AP_CONTEXT,
      // Mastodon-style edit activity id: the note id with a monotonically-unique
      // `#updates/<ts>` fragment so repeated edits never collide.
      id: `${noteId}#updates/${now.getTime()}`,
      type: 'Update',
      actor,
      updated,
      to: note.to,
      cc: note.cc,
      object: {
        ...note,
        updated,
      },
    };
  }

  /**
   * Federate an edit of a local public post as an `Update(Note)` to the editor's
   * remote followers (and, for a reply to a FEDERATED parent, that parent author's
   * inbox — mirroring the reply Create path). A boost never carries an editable
   * body, so it is skipped. Gated identically to {@link federateNewPost};
   * best-effort.
   */
  async federateUpdate(
    post: NoteSourcePost & { visibility: string },
    editorOxyUserId: string,
    editorUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    if (!(await isFediverseSharingEnabled(editorOxyUserId))) return;
    if (post.boostOf) return;
    if (post.visibility !== PostVisibility.PUBLIC) return;

    try {
      const reply = await this.resolveReplyDelivery(post);
      const mentions = await this.resolveMentionContext(post);
      // Re-federate a poll post as an Update(Question) carrying its CURRENT tallies.
      const poll = await this.resolvePollContext(post);
      // A quote post re-federates its quote reference; a non-quote post → null.
      const quote = await this.resolveQuoteContext(post);
      const activity = this.buildUpdateNoteActivity(post, editorUsername, reply?.context, mentions ?? undefined, poll ?? undefined, quote ?? undefined);
      await this.deliverToFollowers(activity, editorOxyUserId, editorUsername, {
        extraInboxes: [
          ...(reply?.parentAuthorInbox ? [reply.parentAuthorInbox] : []),
          ...(mentions?.inboxes ?? []),
        ],
      });
    } catch (err) {
      logger.error('Failed to federate post update:', err);
    }
  }

  /**
   * Build a `Like` of a remote object. `object` is the liked original's canonical
   * AP id (its remote `federation.activityId`). The activity id is minted
   * deterministically from the native Like doc's id so the matching
   * {@link buildUndoLikeActivity} re-mints it without persisting anything. A Like
   * is addressed ONLY at the origin author's inbox (no `to`/`cc` broadcast).
   */
  buildLikeActivity(likerUsername: string, likeId: string, objectUri: string): Record<string, unknown> {
    const actor = actorUrl(likerUsername);
    return {
      '@context': AP_CONTEXT,
      id: `${actor}/likes/${likeId}`,
      type: 'Like',
      actor,
      object: objectUri,
    };
  }

  /** Build the matching `Undo(Like)` — re-mints the SAME Like id + object. */
  buildUndoLikeActivity(likerUsername: string, likeId: string, objectUri: string): Record<string, unknown> {
    const actor = actorUrl(likerUsername);
    const likeActivityId = `${actor}/likes/${likeId}`;
    return {
      '@context': AP_CONTEXT,
      id: `${likeActivityId}/undo`,
      type: 'Undo',
      actor,
      object: {
        id: likeActivityId,
        type: 'Like',
        actor,
        object: objectUri,
      },
    };
  }

  /**
   * Federate a like of a FEDERATED post as a `Like` delivered ONLY to that post's
   * origin author inbox (a like is never broadcast to the liker's own followers —
   * Mastodon does not fan out likes). Local-post likes are a no-op: a local author
   * is notified natively (the `Like` doc), never via ActivityPub, and
   * {@link resolveFederationTarget} yields no remote inbox for them. Gated
   * identically to {@link federateNewPost}; best-effort.
   */
  async federateLike(
    like: { _id: unknown; postId: string },
    likerOxyUserId: string,
    likerUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    if (!(await isFediverseSharingEnabled(likerOxyUserId))) return;

    try {
      const target = await this.resolveFederationTarget(String(like.postId));
      // A remote author inbox exists ONLY for a federated original — its absence
      // means the liked post is local (or its actor is unresolved), so there is
      // nothing to notify over ActivityPub.
      if (!target?.authorInbox) return;
      const activity = this.buildLikeActivity(likerUsername, String(like._id), target.objectUri);
      await this.queueDelivery(activity, target.authorInbox, likerOxyUserId);
    } catch (err) {
      logger.error('Failed to federate like:', err);
    }
  }

  /**
   * Federate an unlike of a FEDERATED post as an `Undo(Like)` to the origin author
   * inbox. The native Like doc is deleted before/around this call, but its id is
   * passed in so the Undo re-mints the exact Like id {@link federateLike} sent.
   * Local-post unlikes are a no-op. Gated identically; best-effort.
   */
  async federateUndoLike(
    like: { _id: unknown; postId: string },
    likerOxyUserId: string,
    likerUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    if (!(await isFediverseSharingEnabled(likerOxyUserId))) return;

    try {
      const target = await this.resolveFederationTarget(String(like.postId));
      if (!target?.authorInbox) return;
      const activity = this.buildUndoLikeActivity(likerUsername, String(like._id), target.objectUri);
      await this.queueDelivery(activity, target.authorInbox, likerOxyUserId);
    } catch (err) {
      logger.error('Failed to federate undo like:', err);
    }
  }

  /**
   * Federate an actor profile change as an `Update(Person)` broadcast to the
   * user's remote followers so Mastodon refreshes the cached actor. Rebuilds the
   * FULL actor document through the SAME {@link buildLocalActorObject} the GET
   * actor route serves, then wraps it in an `Update` — no field diffing, because
   * Mastodon re-reads the whole actor on any actor `Update`.
   *
   * IMPORTANT boundary — only MENTION-OWNED actor fields have a write hook that
   * reaches here (today: the `profileHeaderImage` banner via `profileSettings.ts`).
   * The `name`/`icon`/`summary` (displayName / avatar / bio) are owned by the Oxy
   * API and change WITHOUT any Mention-side write, so an Oxy-side edit does not
   * trigger this broadcast. Propagating those needs a separate Oxy→Mention signal
   * (a webhook) or a periodic actor re-broadcast — see the task report. This
   * broadcast still emits the CURRENT Oxy values, so any Mention-owned change also
   * carries whatever the latest Oxy fields are.
   *
   * Gated identically to {@link federateNewPost}; best-effort.
   */
  async federateActorUpdate(actorOxyUserId: string, username: string): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    if (!(await isFediverseSharingEnabled(actorOxyUserId))) return;

    try {
      const user = (await resolveOxyUser(username)) as ActorUserView | null;
      if (!user) {
        logger.warn(`[FedDeliver] cannot federate actor update for ${username}: user not resolvable`);
        return;
      }

      const publicKey = await getPublicKey(username);
      const settings = await UserSettings.findOne({ oxyUserId: actorOxyUserId }, { profileHeaderImage: 1 })
        .lean<{ profileHeaderImage?: string } | null>();

      // Canonical display name is owned by the Oxy API; fall back to the handle
      // when absent (never recompose from name parts).
      const displayName = user.name?.displayName || username;

      const actorObject = buildLocalActorObject({
        username,
        displayName,
        bio: user.bio,
        avatar: user.avatar,
        profileHeaderImage: settings?.profileHeaderImage,
        publicKey,
        createdAt: user.createdAt,
      });

      const actor = actorUrl(username);
      const now = new Date();
      const activity: Record<string, unknown> = {
        '@context': AP_CONTEXT,
        id: `${actor}#updates/${now.getTime()}`,
        type: 'Update',
        actor,
        updated: now.toISOString(),
        to: [AP_PUBLIC],
        cc: [`${actor}/followers`],
        object: actorObject,
      };

      await this.deliverToFollowers(activity, actorOxyUserId, username);
    } catch (err) {
      logger.error('Failed to federate actor update:', err);
    }
  }

  // ============================================================
  // Follow Management
  // ============================================================

  /**
   * Send a Follow activity to a remote actor.
   */
  async sendFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<{ success: boolean; pending: boolean }> {
    if (!FEDERATION_ENABLED) return { success: false, pending: false };

    // Never block the follow request on a remote actor fetch. Use whatever is
    // cached; if the actor is unknown locally we still record the follow and
    // queue the Follow activity, then refresh the actor in the background.
    const cached = await FederatedActor.findOne({ uri: remoteActorUri }).lean<IFederatedActor>();

    // Always refresh the actor in the background so its inbox/profile stay
    // current (and so a missing actor gets resolved for delivery shortly).
    actorService.refreshActorInBackground(remoteActorUri, cached ?? undefined);

    const canonicalUri = cached?.uri ?? remoteActorUri;
    const localActorUri = actorUrl(localUsername);
    // Use the actor _id when known, otherwise a stable hash of the URI so the
    // activity ID is deterministic across retries before the actor is cached.
    const activityIdSuffix = cached?._id
      ? String(cached._id)
      : encodeURIComponent(canonicalUri);
    const activityId = `${localActorUri}/follows/${activityIdSuffix}`;

    // Create or update the follow record
    await FederatedFollow.findOneAndUpdate(
      { localUserId: localOxyUserId, remoteActorUri: canonicalUri, direction: 'outbound' },
      { $set: { status: 'pending', activityId } },
      { upsert: true, returnDocument: 'after' },
    );

    const activity: Record<string, unknown> = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
      type: 'Follow',
      actor: localActorUri,
      object: canonicalUri,
    };

    // If we know the inbox, attempt delivery in the background; otherwise queue
    // for the delivery worker, which resolves the inbox once the actor lands.
    const targetInbox = cached?.sharedInboxUrl ?? cached?.inboxUrl;
    if (targetInbox) {
      void this.deliverActivity(activity, targetInbox, localOxyUserId, localUsername)
        .then((delivered) => {
          if (!delivered) return this.queueDelivery(activity, targetInbox, localOxyUserId);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[FedSync] background follow delivery failed for ${canonicalUri}: ${message}`);
        });
    } else {
      // No cached inbox yet — resolve the actor's inbox in the background and
      // queue the Follow for delivery once known. Reports success optimistically;
      // the delivery worker retries the queued delivery. Never blocks the caller.
      this.queueFollowOnceActorKnown(activity, canonicalUri, localOxyUserId, remoteActorUri);
    }

    return { success: true, pending: cached?.manuallyApprovesFollowers ?? false };
  }

  /**
   * Resolve the target actor's inbox in the background and queue the Follow
   * activity for delivery once known. Fire-and-forget: returns synchronously and
   * never blocks the caller on remote I/O.
   */
  private queueFollowOnceActorKnown(
    activity: Record<string, unknown>,
    canonicalUri: string,
    localOxyUserId: string,
    remoteActorUri: string,
  ): void {
    void (async () => {
      try {
        let actor = await FederatedActor.findOne({ uri: canonicalUri }).lean<IFederatedActor>();
        if (!actor?.inboxUrl) {
          actor = await actorService.fetchRemoteActor(remoteActorUri) as IFederatedActor | null;
        }
        const inbox = actor?.sharedInboxUrl ?? actor?.inboxUrl;
        if (inbox) {
          await this.queueDelivery(activity, inbox, localOxyUserId);
        } else {
          logger.warn(`[FedSync] could not resolve inbox to deliver Follow to ${remoteActorUri}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedSync] deferred follow delivery setup failed for ${remoteActorUri}: ${message}`);
      }
    })();
  }

  /**
   * Send an Undo(Follow) activity to a remote actor.
   */
  async sendUndoFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<boolean> {
    if (!FEDERATION_ENABLED) return false;

    const follow = await FederatedFollow.findOne({
      localUserId: localOxyUserId,
      remoteActorUri,
      direction: 'outbound',
    });
    if (!follow) return false;

    const actor = await FederatedActor.findOne({ uri: remoteActorUri }).lean();
    if (!actor) return false;

    const localActorUri = actorUrl(localUsername);

    const activity: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: `${localActorUri}/follows/${actor._id}/undo`,
      type: 'Undo',
      actor: localActorUri,
      object: {
        id: follow.activityId,
        type: 'Follow',
        actor: localActorUri,
        object: remoteActorUri,
      },
    };

    // Remove the local follow immediately so the unfollow reflects in the UI,
    // then deliver the Undo in the background — never block the request on the
    // remote POST.
    await FederatedFollow.deleteOne({ _id: follow._id });

    // `inboxUrl` is schema-optional (atproto actors have none); an AP actor we
    // are sending Undo(Follow) to always has one. When neither inbox is known the
    // local follow is already removed — just skip the outbound delivery.
    const targetInbox = actor.sharedInboxUrl ?? actor.inboxUrl;
    if (targetInbox) {
      void this.deliverActivity(activity, targetInbox, localOxyUserId, localUsername)
        .then((delivered) => {
          if (!delivered) return this.queueDelivery(activity, targetInbox, localOxyUserId);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[FedSync] background undo-follow delivery failed for ${remoteActorUri}: ${message}`);
        });
    }

    return true;
  }

  /**
   * Send an Accept(Follow) activity back to a remote actor.
   */
  async sendAccept(
    localOxyUserId: string,
    localUsername: string,
    followActivityId: string,
    remoteActorUri: string,
  ): Promise<void> {
    const actor = await FederatedActor.findOne({ uri: remoteActorUri }).lean();
    if (!actor) return;
    // `inboxUrl` is schema-optional (atproto actors have none); an AP actor we
    // are sending Accept(Follow) to always has one. Guard so the absent case is
    // a logged no-op instead of delivering to `undefined`.
    if (!actor.inboxUrl) {
      logger.warn(`[FedSync] cannot send Accept(Follow) to ${remoteActorUri}: actor has no inboxUrl`);
      return;
    }

    const localActorUri = actorUrl(localUsername);

    const activity: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: `${localActorUri}/accepts/${Date.now()}`,
      type: 'Accept',
      actor: localActorUri,
      object: {
        id: followActivityId,
        type: 'Follow',
        actor: remoteActorUri,
        object: localActorUri,
      },
    };

    const delivered = await this.deliverActivity(activity, actor.inboxUrl, localOxyUserId, localUsername);
    if (!delivered) {
      await this.queueDelivery(activity, actor.inboxUrl, localOxyUserId);
    }
  }
}

export const followService = new FollowService();
export default followService;
