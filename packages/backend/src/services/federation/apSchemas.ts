/**
 * Zod validation schemas for INBOUND ActivityPub objects (Fediverse → Mention).
 *
 * Incoming federation JSON arrives from arbitrary, UNTRUSTED remote servers
 * (Mastodon, Pleroma, Misskey, PeerTube, Lemmy, Threads, etc.) and is today
 * parsed with raw property access. These schemas are the validation FOUNDATION
 * for that ingest: every shape and field constrained here was derived from what
 * the ingest code actually consumes —
 *   - `services/federation/InboxProcessingService.ts` (Follow/Undo/Create/Delete/
 *     Like/Announce/Accept/Reject/Update dispatch + handlers),
 *   - `services/federation/OutboxSyncService.ts` (outbox backfill, Note/Announce
 *     candidate extraction, boost import),
 *   - `services/federation/ActorService.ts` (`fetchRemoteActor` field reads),
 *   - `services/federation/sharedFederationHelpers.ts` (attributedTo / announced
 *     object / addressing / tag extraction),
 *   - `utils/federation/apMedia.ts` (attachment URL shapes),
 *   - `utils/federation/apLanguage.ts` (`language` / `contentMap`).
 *
 * Design principles:
 *  - LENIENT by AP spec: every object schema is `.loose()` (zod v4 passthrough)
 *    so unknown extension fields from any server never fail validation — only
 *    the fields WE read are constrained.
 *  - `type` may be a single string OR an array of strings (some servers, e.g.
 *    certain Lemmy/PeerTube objects, send an array). `apType` models both.
 *  - `object` / `attributedTo` / addressing are modeled as the string-IRI OR
 *    embedded-object unions the code branches on.
 *  - `published` is validated as an ISO-8601 datetime and COERCED to a JS `Date`
 *    (preserving the original instant). This is the contract the date-fix relies
 *    on so imported federated posts carry their REAL original timestamp instead
 *    of the time we happened to ingest them.
 *  - Remote data is NEVER trusted to be well-formed: every parse helper uses
 *    `safeParse` and returns a discriminated `{ ok }` result. Nothing here throws
 *    on bad input.
 *
 * NOTE: This module is the foundation only — it is intentionally NOT yet wired
 * into the ingest services. Follow-up inbox/outbox applier agents consume it.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared scalar / sub-schemas
// ---------------------------------------------------------------------------

/**
 * An ActivityPub `id` / IRI. AP ids are absolute URIs in practice, but remote
 * servers are not uniformly strict, so this is a non-empty string rather than a
 * strict URL — callers that need an absolute http(s) URL re-check with the
 * existing `isAbsoluteHttpUrl` helper. Empty strings are rejected because the
 * ingest code treats a missing/empty id as "no id".
 */
export const apId = z.string().min(1);

/**
 * Optional `published` timestamp.
 *
 * Validates an ISO-8601 datetime WITH timezone offset (`Z` or `±HH:MM`) and
 * ALSO accepts a local (offset-less) datetime, then PIPES the validated string
 * through `z.coerce.date()` so the parsed value is a real JS `Date` carrying the
 * original instant. Offset-bearing inputs normalize to the correct UTC instant
 * (e.g. `2023-11-02T14:25:43+02:00` → `2023-11-02T12:25:43Z`).
 *
 * This is the single contract the federated-post date fix depends on: a Note's
 * past `published` must coerce to a `Date` with that past time so the imported
 * post's `createdAt` reflects when it was authored upstream — not when Mention
 * ingested it.
 */
export const apPublished = z
  .string()
  .datetime({ offset: true, local: true })
  .pipe(z.coerce.date())
  .optional();

/**
 * AP `type`: a single string OR an array of strings. Some servers advertise
 * multiple types (e.g. `["Note", "..."]`); the ingest code only ever compares
 * against the primary type, so an array is accepted and downstream helpers can
 * normalize it with {@link primaryApType}.
 */
export const apType = z.union([z.string(), z.array(z.string())]);

/** The primary `type` string from an `apType` value (first entry of an array). */
export function primaryApType(type: string | string[] | undefined): string | undefined {
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type[0];
  return undefined;
}

/**
 * A single AP `Link` object as it appears inside `attachment[].url`
 * (Pleroma/PeerTube/Lemmy). Mirrors `ApUrlEntry` in `utils/federation/apMedia.ts`.
 */
export const apLinkEntrySchema = z
  .object({
    type: apType.optional(),
    href: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .loose();

/**
 * An AP Note `attachment` entry (media). `url` is a string (Mastodon), a single
 * Link object (Pleroma/Misskey), or an array of Link objects (PeerTube/Lemmy).
 * Also covers actor `PropertyValue` attachments (profile fields), which carry
 * `name` + `value` (+ optional `verifiedAt`) instead of `url`.
 */
export const apAttachmentSchema = z
  .object({
    type: apType.optional(),
    mediaType: z.string().optional(),
    name: z.string().optional(),
    url: z
      .union([z.string(), apLinkEntrySchema, z.array(z.union([z.string(), apLinkEntrySchema]))])
      .optional(),
    // PropertyValue (actor profile fields)
    value: z.string().optional(),
    verifiedAt: z.string().optional(),
  })
  .loose();

/**
 * An AP `tag` entry. Covers `Hashtag` (with `name`), `Mention` (with `href`),
 * and custom `Emoji`. Only `type`, `name`, and `href` are read by the ingest
 * code (`extractApHashtags`).
 */
export const apTagSchema = z
  .object({
    type: apType.optional(),
    name: z.string().optional(),
    href: z.string().optional(),
  })
  .loose();

/**
 * An AP `icon` / `image` value. AP allows a string URL, an `Image` object with
 * a `url` (string or nested Link), or an array of either. The ingest code runs
 * this through `firstStringUrl`, so the schema is deliberately permissive and
 * only constrains the optional shape.
 */
export const apImageSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z
      .object({
        type: apType.optional(),
        mediaType: z.string().optional(),
        url: z.union([z.string(), apLinkEntrySchema, z.array(z.union([z.string(), apLinkEntrySchema]))]).optional(),
        href: z.string().optional(),
      })
      .loose(),
    z.array(apImageSchema),
  ]),
);

/** Addressing field (`to` / `cc` / `audience`): a single IRI or an array of IRIs. */
export const apAddressing = z.union([z.string(), z.array(z.string())]).optional();

/** A `publicKey` block on an actor. Only `id` + `publicKeyPem` are read. */
export const apPublicKeySchema = z
  .object({
    id: z.string().optional(),
    owner: z.string().optional(),
    publicKeyPem: z.string().optional(),
  })
  .loose();

/** Actor `endpoints` block — only `sharedInbox` is read. */
export const apEndpointsSchema = z
  .object({
    sharedInbox: z.string().optional(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Object schemas (Note / Article / Question / Page, Tombstone, Actor)
// ---------------------------------------------------------------------------

/**
 * Base fields shared by content objects (Note, Article, Question, Page).
 * Every server adds its own extensions, hence `.loose()`. `id` and `type` are
 * required because the ingest code keys dedup + dispatch off them.
 */
const apContentObjectBase = {
  id: apId,
  type: apType,
  attributedTo: z.union([z.string(), apLinkEntrySchema]).optional(),
  content: z.string().optional(),
  contentMap: z.record(z.string(), z.string()).optional(),
  name: z.string().optional(),
  summary: z.string().nullable().optional(),
  published: apPublished,
  updated: apPublished,
  inReplyTo: z.union([z.string(), apLinkEntrySchema]).nullable().optional(),
  url: z
    .union([z.string(), apLinkEntrySchema, z.array(z.union([z.string(), apLinkEntrySchema]))])
    .optional(),
  sensitive: z.boolean().optional(),
  language: z.string().optional(),
  to: apAddressing,
  cc: apAddressing,
  audience: apAddressing,
  tag: z.array(apTagSchema).optional(),
  attachment: z.array(apAttachmentSchema).optional(),
};

/**
 * A content object: `Note` (Mastodon/Pleroma status), `Article` (long-form,
 * WriteFreely/Lemmy posts), `Question` (Mastodon poll), or `Page` (PeerTube/
 * Lemmy). They share the same base shape for the fields Mention reads; the
 * ingest code only stores `Note`/`Article` today, but `Question`/`Page` parse
 * cleanly so future wiring is non-breaking.
 */
export const apNoteSchema = z.object(apContentObjectBase).loose();

/**
 * A `Tombstone` — the `object` of a `Delete` activity for a removed post. Only
 * `id` (+ optional `type`/`formerType`/`deleted`) is read; matched against
 * `federation.activityId`.
 */
export const apTombstoneSchema = z
  .object({
    id: apId,
    type: apType.optional(),
    formerType: apType.optional(),
    deleted: z.string().optional(),
  })
  .loose();

/**
 * An AP actor: `Person` (user), `Service` (bot/relay), `Application`
 * (instance/automation), `Group` (Lemmy community / Guppe), or `Organization`.
 * `id` and `inbox` are required because `fetchRemoteActor` rejects an actor
 * missing either. Everything else is optional + lenient.
 */
export const apActorSchema = z
  .object({
    id: apId,
    type: apType.optional(),
    inbox: z.string(),
    outbox: z.string().optional(),
    followers: z.string().optional(),
    following: z.string().optional(),
    preferredUsername: z.string().optional(),
    name: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    url: z
      .union([z.string(), apLinkEntrySchema, z.array(z.union([z.string(), apLinkEntrySchema]))])
      .optional(),
    icon: apImageSchema.optional(),
    image: apImageSchema.optional(),
    publicKey: apPublicKeySchema.optional(),
    endpoints: apEndpointsSchema.optional(),
    manuallyApprovesFollowers: z.boolean().optional(),
    discoverable: z.boolean().optional(),
    memorial: z.boolean().optional(),
    suspended: z.boolean().optional(),
    attachment: z.array(apAttachmentSchema).optional(),
    featured: z.string().optional(),
    featuredTags: z.string().optional(),
    alsoKnownAs: z.array(z.string()).optional(),
    published: apPublished,
    webfinger: z.string().optional(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Activity schemas
// ---------------------------------------------------------------------------

/**
 * An activity `object` that may be an embedded object OR a bare string IRI.
 * The ingest code branches on `typeof object === 'string'` everywhere, so this
 * union is the canonical model for that.
 */
export const apObjectOrIri = z.union([z.string(), z.object({ id: apId.optional(), type: apType.optional() }).loose()]);

/** `Create` — wraps a new Note/Article. `object` is usually embedded. */
export const apCreateSchema = z
  .object({
    id: apId,
    type: z.literal('Create'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: z.union([z.string(), apNoteSchema]),
    published: apPublished,
    to: apAddressing,
    cc: apAddressing,
  })
  .loose();

/** `Update` — an edited Note/Article OR an updated actor (profile change). */
export const apUpdateSchema = z
  .object({
    id: apId,
    type: z.literal('Update'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: z.union([z.string(), apNoteSchema, apActorSchema]),
    published: apPublished,
  })
  .loose();

/** `Delete` — `object` is the deleted object's IRI or a `Tombstone`. */
export const apDeleteSchema = z
  .object({
    id: apId.optional(),
    type: z.literal('Delete'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: z.union([z.string(), apTombstoneSchema]),
    published: apPublished,
  })
  .loose();

/** `Announce` (boost/reblog) — `object` is the announced object's IRI or embed. */
export const apAnnounceSchema = z
  .object({
    id: apId,
    type: z.literal('Announce'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: apObjectOrIri,
    url: z.string().optional(),
    published: apPublished,
    to: apAddressing,
    cc: apAddressing,
  })
  .loose();

/** `Like` (favourite) — `object` is the liked post's IRI or embed. */
export const apLikeSchema = z
  .object({
    id: apId.optional(),
    type: z.literal('Like'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: apObjectOrIri,
    published: apPublished,
  })
  .loose();

/** `Follow` — `object` is the followed actor's IRI or embed. */
export const apFollowSchema = z
  .object({
    id: apId.optional(),
    type: z.literal('Follow'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: apObjectOrIri,
  })
  .loose();

/**
 * `Accept` / `Reject` — confirms/denies a Follow. `object` is the original
 * Follow activity, sent either embedded (`{ type:'Follow', id }`) or as a bare
 * string reference (the Follow activity id). Both variants are handled.
 */
export const apAcceptSchema = z
  .object({
    id: apId.optional(),
    type: z.literal('Accept'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: apObjectOrIri,
  })
  .loose();

export const apRejectSchema = z
  .object({
    id: apId.optional(),
    type: z.literal('Reject'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: apObjectOrIri,
  })
  .loose();

/**
 * `Undo` — reverses a prior Follow / Like / Announce. `object` is the wrapped
 * activity (embedded), or occasionally a bare IRI. The handler branches on the
 * wrapped object's `type`, so the embedded form carries an optional `type`.
 */
export const apUndoSchema = z
  .object({
    id: apId.optional(),
    type: z.literal('Undo'),
    actor: z.union([z.string(), apLinkEntrySchema]).optional(),
    object: z.union([
      z.string(),
      z
        .object({
          id: apId.optional(),
          type: apType.optional(),
          actor: z.union([z.string(), apLinkEntrySchema]).optional(),
          object: apObjectOrIri.optional(),
        })
        .loose(),
    ]),
  })
  .loose();

/**
 * Discriminated-ish union of every inbound activity type the inbox dispatches
 * on. `type` is normalized to its primary string before discrimination because
 * remote servers may send `type` as an array; we therefore use a plain `union`
 * rather than `discriminatedUnion` (which requires a literal single-value
 * discriminator key).
 */
export const apInboundActivitySchema = z.union([
  apCreateSchema,
  apUpdateSchema,
  apDeleteSchema,
  apAnnounceSchema,
  apLikeSchema,
  apFollowSchema,
  apAcceptSchema,
  apRejectSchema,
  apUndoSchema,
]);

// ---------------------------------------------------------------------------
// Outbox collection schemas
// ---------------------------------------------------------------------------

/**
 * `OrderedCollectionPage` (or `CollectionPage`) — one page of an actor's
 * outbox. `orderedItems` (or `items`) holds activities (often `Create`/
 * `Announce`) or bare IRIs; `next`/`prev`/`first`/`last` are pagination links
 * (string IRI or a Link object). `OutboxSyncService.activityPubItems` reads
 * `orderedItems`/`items`; `activityPubLinkUrl` reads `next`/`first`.
 */
export const apOrderedCollectionPageSchema = z
  .object({
    id: z.string().optional(),
    type: apType.optional(),
    totalItems: z.number().optional(),
    orderedItems: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    next: z.union([z.string(), apLinkEntrySchema]).optional(),
    prev: z.union([z.string(), apLinkEntrySchema]).optional(),
    first: z.union([z.string(), apLinkEntrySchema]).optional(),
    last: z.union([z.string(), apLinkEntrySchema]).optional(),
    partOf: z.string().optional(),
  })
  .loose();

/**
 * `OrderedCollection` (or `Collection`) — the top-level outbox. May inline its
 * items (`orderedItems`/`items`) or expose only `first`/`next` pagination links
 * to pages. `totalItems` is read to detect a non-empty-but-uninspectable outbox.
 */
export const apOrderedCollectionSchema = z
  .object({
    id: z.string().optional(),
    type: apType.optional(),
    totalItems: z.number().optional(),
    orderedItems: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    first: z.union([z.string(), apOrderedCollectionPageSchema, apLinkEntrySchema]).optional(),
    next: z.union([z.string(), apLinkEntrySchema]).optional(),
    last: z.union([z.string(), apLinkEntrySchema]).optional(),
  })
  .loose();

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type ApPublished = z.infer<typeof apPublished>;
export type ApType = z.infer<typeof apType>;
export type ApLinkEntry = z.infer<typeof apLinkEntrySchema>;
export type ApAttachment = z.infer<typeof apAttachmentSchema>;
export type ApTag = z.infer<typeof apTagSchema>;
export type ApPublicKey = z.infer<typeof apPublicKeySchema>;
export type ApNote = z.infer<typeof apNoteSchema>;
export type ApTombstone = z.infer<typeof apTombstoneSchema>;
export type ApActor = z.infer<typeof apActorSchema>;
export type ApObjectOrIri = z.infer<typeof apObjectOrIri>;
export type ApCreate = z.infer<typeof apCreateSchema>;
export type ApUpdate = z.infer<typeof apUpdateSchema>;
export type ApDelete = z.infer<typeof apDeleteSchema>;
export type ApAnnounce = z.infer<typeof apAnnounceSchema>;
export type ApLike = z.infer<typeof apLikeSchema>;
export type ApFollow = z.infer<typeof apFollowSchema>;
export type ApAccept = z.infer<typeof apAcceptSchema>;
export type ApReject = z.infer<typeof apRejectSchema>;
export type ApUndo = z.infer<typeof apUndoSchema>;
export type ApInboundActivity = z.infer<typeof apInboundActivitySchema>;
export type ApOrderedCollection = z.infer<typeof apOrderedCollectionSchema>;
export type ApOrderedCollectionPage = z.infer<typeof apOrderedCollectionPageSchema>;

// ---------------------------------------------------------------------------
// Safe-parse helpers (never throw on untrusted remote data)
// ---------------------------------------------------------------------------

/**
 * Discriminated result of validating untrusted remote AP JSON. `ok:false`
 * carries the `ZodError` so callers can log a precise reason without a throw.
 */
export type ApParseResult<T> = { ok: true; data: T } | { ok: false; error: z.ZodError };

/** Wrap a zod `safeParse` into the {@link ApParseResult} discriminated shape. */
function toResult<T>(parsed: z.ZodSafeParseResult<T>): ApParseResult<T> {
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: parsed.error };
}

/**
 * Validate an inbound inbox activity (Create/Update/Delete/Announce/Like/
 * Follow/Accept/Reject/Undo). Returns a discriminated result and NEVER throws,
 * because the input is arbitrary remote JSON.
 */
export function parseInboundActivity(raw: unknown): ApParseResult<ApInboundActivity> {
  return toResult(apInboundActivitySchema.safeParse(raw));
}

/** Validate a content object (Note/Article/Question/Page). Never throws. */
export function parseNote(raw: unknown): ApParseResult<ApNote> {
  return toResult(apNoteSchema.safeParse(raw));
}

/** Validate an AP actor (Person/Service/Application/Group/Organization). Never throws. */
export function parseActor(raw: unknown): ApParseResult<ApActor> {
  return toResult(apActorSchema.safeParse(raw));
}

/** Validate an outbox `OrderedCollection`/`Collection`. Never throws. */
export function parseOrderedCollection(raw: unknown): ApParseResult<ApOrderedCollection> {
  return toResult(apOrderedCollectionSchema.safeParse(raw));
}

/** Validate an outbox `OrderedCollectionPage`/`CollectionPage`. Never throws. */
export function parseOrderedCollectionPage(raw: unknown): ApParseResult<ApOrderedCollectionPage> {
  return toResult(apOrderedCollectionPageSchema.safeParse(raw));
}
