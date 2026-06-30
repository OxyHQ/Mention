import { describe, it, expect } from 'vitest';
import {
  apPublished,
  apType,
  primaryApType,
  apNoteSchema,
  apTombstoneSchema,
  apActorSchema,
  apCreateSchema,
  apUpdateSchema,
  apDeleteSchema,
  apAnnounceSchema,
  apLikeSchema,
  apFollowSchema,
  apAcceptSchema,
  apUndoSchema,
  apOrderedCollectionSchema,
  apOrderedCollectionPageSchema,
  parseInboundActivity,
  parseNote,
  parseActor,
  parseOrderedCollection,
  parseOrderedCollectionPage,
} from '../../../connectors/activitypub/apSchemas';

// ---------------------------------------------------------------------------
// apPublished — the date-fix contract: validate ISO-8601 + coerce to Date
// preserving the original instant.
// ---------------------------------------------------------------------------

describe('apPublished', () => {
  it('coerces a UTC (Z) datetime to a Date with the original instant', () => {
    const iso = '2021-03-15T08:30:00Z';
    const r = apPublished.safeParse(iso);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toBeInstanceOf(Date);
    expect((r.data as Date).getTime()).toBe(new Date(iso).getTime());
  });

  it('preserves a PAST instant (anchor for the federated-post date bug)', () => {
    const past = '2019-07-04T12:00:00.000Z';
    const r = apPublished.safeParse(past);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const d = r.data as Date;
    // The Date must reflect the past authored time, NOT "now".
    expect(d.getUTCFullYear()).toBe(2019);
    expect(d.getUTCMonth()).toBe(6); // July (0-indexed)
    expect(d.getUTCDate()).toBe(4);
    expect(d.toISOString()).toBe('2019-07-04T12:00:00.000Z');
    expect(d.getTime()).toBeLessThan(Date.now());
  });

  it('normalizes a +HH:MM offset to the correct UTC instant', () => {
    const r = apPublished.safeParse('2023-11-02T14:25:43+02:00');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect((r.data as Date).toISOString()).toBe('2023-11-02T12:25:43.000Z');
  });

  it('accepts fractional seconds (Mastodon/Pleroma millis & micros)', () => {
    expect(apPublished.safeParse('2021-03-15T08:30:00.123Z').success).toBe(true);
    expect(apPublished.safeParse('2024-01-01T00:00:00.123456Z').success).toBe(true);
  });

  it('accepts a local (offset-less) datetime for lenient servers', () => {
    expect(apPublished.safeParse('2021-03-15T08:30:00').success).toBe(true);
  });

  it('is optional (undefined passes through)', () => {
    const r = apPublished.safeParse(undefined);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBeUndefined();
  });

  it('rejects malformed datetimes', () => {
    expect(apPublished.safeParse('not-a-date').success).toBe(false);
    expect(apPublished.safeParse('2021-03-15').success).toBe(false); // date only
    expect(apPublished.safeParse('2021-03-15 08:30:00').success).toBe(false); // space sep
    expect(apPublished.safeParse(1615797000000).success).toBe(false); // epoch number
  });
});

// ---------------------------------------------------------------------------
// apType — string or array of strings, primary normalization
// ---------------------------------------------------------------------------

describe('apType + primaryApType', () => {
  it('accepts a single string type', () => {
    expect(apType.safeParse('Note').success).toBe(true);
  });

  it('accepts an array of string types', () => {
    expect(apType.safeParse(['Note', 'ExtensionType']).success).toBe(true);
  });

  it('rejects a non-string array entry', () => {
    expect(apType.safeParse([1, 2]).success).toBe(false);
  });

  it('primaryApType returns the first entry for arrays and the value for strings', () => {
    expect(primaryApType('Note')).toBe('Note');
    expect(primaryApType(['Page', 'Note'])).toBe('Page');
    expect(primaryApType(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// apNoteSchema — realistic Mastodon / PeerTube / Lemmy shapes
// ---------------------------------------------------------------------------

describe('apNoteSchema', () => {
  it('parses a realistic Mastodon Note with published, tags and attachment', () => {
    const note = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://mastodon.social/users/alice/statuses/110000000000000001',
      type: 'Note',
      attributedTo: 'https://mastodon.social/users/alice',
      content: '<p>Hello fediverse <a href="#">#intro</a></p>',
      contentMap: { en: '<p>Hello fediverse</p>' },
      summary: null,
      published: '2023-05-01T10:15:30.000Z',
      inReplyTo: null,
      url: 'https://mastodon.social/@alice/110000000000000001',
      sensitive: false,
      language: 'en',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: ['https://mastodon.social/users/alice/followers'],
      tag: [{ type: 'Hashtag', name: '#intro', href: 'https://mastodon.social/tags/intro' }],
      attachment: [
        { type: 'Document', mediaType: 'image/jpeg', url: 'https://files.mastodon.social/x.jpg' },
      ],
    };
    const r = parseNote(note);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe(note.id);
    expect(r.data.published).toBeInstanceOf(Date);
    expect((r.data.published as Date).toISOString()).toBe('2023-05-01T10:15:30.000Z');
    // unknown extension field (@context) is preserved (loose)
    expect((r.data as Record<string, unknown>)['@context']).toBeDefined();
  });

  it('parses a PeerTube Video-style object with attributedTo object + array url attachment', () => {
    const note = {
      id: 'https://peertube.example/videos/watch/abc',
      type: 'Note',
      attributedTo: { type: 'Person', id: 'https://peertube.example/accounts/bob' },
      content: 'A video',
      published: '2022-09-09T09:09:09Z',
      attachment: [
        {
          type: 'Video',
          url: [
            { type: 'Link', mediaType: 'video/mp4', href: 'https://peertube.example/v/720.mp4' },
            { type: 'Link', mediaType: 'application/x-mpegURL', href: 'https://peertube.example/v/master.m3u8' },
          ],
        },
      ],
    };
    const r = parseNote(note);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data.published as Date).toISOString()).toBe('2022-09-09T09:09:09.000Z');
  });

  it('parses a Lemmy-style Article with type sent as an array', () => {
    const note = {
      id: 'https://lemmy.example/post/42',
      type: ['Page', 'Article'],
      attributedTo: 'https://lemmy.example/u/carol',
      name: 'A title',
      content: '<p>body</p>',
      published: '2024-02-20T20:20:20.000Z',
    };
    const r = parseNote(note);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(primaryApType(r.data.type)).toBe('Page');
  });

  it('fails when id is missing', () => {
    const r = parseNote({ type: 'Note', content: 'no id' });
    expect(r.ok).toBe(false);
  });

  it('fails when published is a malformed datetime', () => {
    const r = parseNote({ id: 'https://x/y', type: 'Note', published: 'yesterday' });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// apTombstoneSchema
// ---------------------------------------------------------------------------

describe('apTombstoneSchema', () => {
  it('parses a Tombstone with formerType', () => {
    const r = apTombstoneSchema.safeParse({
      id: 'https://mastodon.social/users/alice/statuses/1',
      type: 'Tombstone',
      formerType: 'Note',
      deleted: '2024-01-01T00:00:00Z',
    });
    expect(r.success).toBe(true);
  });

  it('fails without an id', () => {
    expect(apTombstoneSchema.safeParse({ type: 'Tombstone' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// apActorSchema — Person / Service / Application / Group
// ---------------------------------------------------------------------------

describe('apActorSchema', () => {
  it('parses a realistic Mastodon Person actor', () => {
    const actor = {
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: 'https://mastodon.social/users/alice',
      type: 'Person',
      preferredUsername: 'alice',
      name: 'Alice',
      summary: '<p>bio</p>',
      inbox: 'https://mastodon.social/users/alice/inbox',
      outbox: 'https://mastodon.social/users/alice/outbox',
      followers: 'https://mastodon.social/users/alice/followers',
      following: 'https://mastodon.social/users/alice/following',
      icon: { type: 'Image', mediaType: 'image/png', url: 'https://files.mastodon.social/avatar.png' },
      image: { type: 'Image', url: 'https://files.mastodon.social/header.png' },
      publicKey: {
        id: 'https://mastodon.social/users/alice#main-key',
        owner: 'https://mastodon.social/users/alice',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMII...\n-----END PUBLIC KEY-----',
      },
      endpoints: { sharedInbox: 'https://mastodon.social/inbox' },
      manuallyApprovesFollowers: false,
      discoverable: true,
      published: '2018-08-25T00:00:00Z',
      attachment: [{ type: 'PropertyValue', name: 'Website', value: '<a href="https://x">x</a>' }],
    };
    const r = parseActor(actor);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe(actor.id);
    expect(r.data.inbox).toBe(actor.inbox);
    expect((r.data.published as Date).toISOString()).toBe('2018-08-25T00:00:00.000Z');
  });

  it('parses a Group actor (Lemmy community / Guppe) with icon as a bare string URL', () => {
    const actor = {
      id: 'https://lemmy.example/c/news',
      type: 'Group',
      preferredUsername: 'news',
      inbox: 'https://lemmy.example/c/news/inbox',
      icon: 'https://lemmy.example/pictrs/image/icon.png',
    };
    const r = parseActor(actor);
    expect(r.ok).toBe(true);
  });

  it('parses a Service actor', () => {
    const r = parseActor({
      id: 'https://relay.example/actor',
      type: 'Service',
      inbox: 'https://relay.example/inbox',
    });
    expect(r.ok).toBe(true);
  });

  it('fails when inbox is missing', () => {
    const r = parseActor({ id: 'https://x/actor', type: 'Person' });
    expect(r.ok).toBe(false);
  });

  it('fails when id is missing', () => {
    const r = parseActor({ type: 'Person', inbox: 'https://x/inbox' });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Activity schemas via parseInboundActivity
// ---------------------------------------------------------------------------

describe('parseInboundActivity', () => {
  it('parses a Create wrapping an embedded Note and coerces nested published', () => {
    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://mastodon.social/users/alice/statuses/1/activity',
      type: 'Create',
      actor: 'https://mastodon.social/users/alice',
      published: '2023-05-01T10:15:30Z',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: {
        id: 'https://mastodon.social/users/alice/statuses/1',
        type: 'Note',
        attributedTo: 'https://mastodon.social/users/alice',
        content: '<p>hi</p>',
        published: '2023-05-01T10:15:30Z',
      },
    };
    const r = parseInboundActivity(activity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.type).toBe('Create');
    const obj = (r.data as { object: unknown }).object as { published?: Date };
    expect(obj.published).toBeInstanceOf(Date);
    expect((obj.published as Date).toISOString()).toBe('2023-05-01T10:15:30.000Z');
  });

  it('parses an Announce wrapping a Note by IRI (object as string)', () => {
    const activity = {
      id: 'https://mastodon.social/users/bob/statuses/9/activity',
      type: 'Announce',
      actor: 'https://mastodon.social/users/bob',
      object: 'https://peertube.example/videos/watch/abc',
      published: '2024-03-03T03:03:03Z',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    };
    const r = parseInboundActivity(activity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.type).toBe('Announce');
    expect((r.data as { object: unknown }).object).toBe('https://peertube.example/videos/watch/abc');
  });

  it('parses an Announce wrapping an embedded object', () => {
    const r = parseInboundActivity({
      id: 'https://x/announce/1',
      type: 'Announce',
      actor: 'https://x/users/z',
      object: { id: 'https://y/note/1', type: 'Note' },
    });
    expect(r.ok).toBe(true);
  });

  it('parses a Like (object as IRI)', () => {
    const r = parseInboundActivity({
      id: 'https://mastodon.social/users/bob#likes/3',
      type: 'Like',
      actor: 'https://mastodon.social/users/bob',
      object: 'https://mention.earth/ap/posts/64b000000000000000000000',
    });
    expect(r.ok).toBe(true);
    expect(apLikeSchema.safeParse({ type: 'Like', actor: 'https://x', object: 'https://y' }).success).toBe(true);
  });

  it('parses a Follow', () => {
    const r = parseInboundActivity({
      id: 'https://mastodon.social/users/bob#follows/7',
      type: 'Follow',
      actor: 'https://mastodon.social/users/bob',
      object: 'https://mention.earth/ap/users/alice',
    });
    expect(r.ok).toBe(true);
    expect(apFollowSchema.safeParse({ type: 'Follow', object: 'https://x/users/a' }).success).toBe(true);
  });

  it('parses an Accept with an embedded Follow object', () => {
    const r = parseInboundActivity({
      id: 'https://mastodon.social/users/alice#accepts/2',
      type: 'Accept',
      actor: 'https://mastodon.social/users/alice',
      object: { id: 'https://mention.earth/ap/follows/1', type: 'Follow' },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.type).toBe('Accept');
  });

  it('parses an Accept with a string object reference (Follow activity id)', () => {
    expect(
      apAcceptSchema.safeParse({
        type: 'Accept',
        actor: 'https://x/users/a',
        object: 'https://mention.earth/ap/follows/1',
      }).success,
    ).toBe(true);
  });

  it('parses an Undo(Follow) with the wrapped activity embedded', () => {
    const r = parseInboundActivity({
      id: 'https://mastodon.social/users/bob#undo/1',
      type: 'Undo',
      actor: 'https://mastodon.social/users/bob',
      object: {
        id: 'https://mastodon.social/users/bob#follows/7',
        type: 'Follow',
        actor: 'https://mastodon.social/users/bob',
        object: 'https://mention.earth/ap/users/alice',
      },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.type).toBe('Undo');
  });

  it('parses an Undo(Like) and Undo(Announce)', () => {
    expect(
      apUndoSchema.safeParse({
        type: 'Undo',
        actor: 'https://x/users/a',
        object: { type: 'Like', object: 'https://y/note/1' },
      }).success,
    ).toBe(true);
    expect(
      apUndoSchema.safeParse({
        type: 'Undo',
        actor: 'https://x/users/a',
        object: { type: 'Announce', id: 'https://x/announce/1', object: 'https://y/note/1' },
      }).success,
    ).toBe(true);
  });

  it('parses a Delete with a Tombstone object', () => {
    const r = parseInboundActivity({
      id: 'https://mastodon.social/users/alice#delete/1',
      type: 'Delete',
      actor: 'https://mastodon.social/users/alice',
      object: {
        id: 'https://mastodon.social/users/alice/statuses/1',
        type: 'Tombstone',
      },
    });
    expect(r.ok).toBe(true);
  });

  it('parses a Delete with a bare string object (deleted IRI)', () => {
    expect(
      apDeleteSchema.safeParse({
        type: 'Delete',
        actor: 'https://x/users/a',
        object: 'https://x/users/a/statuses/1',
      }).success,
    ).toBe(true);
  });

  it('parses an Update of a Note', () => {
    const r = apUpdateSchema.safeParse({
      id: 'https://x/update/1',
      type: 'Update',
      actor: 'https://x/users/a',
      object: { id: 'https://x/note/1', type: 'Note', content: '<p>edited</p>' },
    });
    expect(r.success).toBe(true);
  });

  it('parses an Update of an actor (profile change)', () => {
    const r = apUpdateSchema.safeParse({
      id: 'https://x/update/2',
      type: 'Update',
      actor: 'https://x/users/a',
      object: { id: 'https://x/users/a', type: 'Person', inbox: 'https://x/users/a/inbox', name: 'New Name' },
    });
    expect(r.success).toBe(true);
  });

  it('parses a Create wrapping a Note via type-as-array', () => {
    const r = apCreateSchema.safeParse({
      id: 'https://x/create/1',
      type: 'Create',
      actor: 'https://x/users/a',
      object: { id: 'https://x/note/1', type: ['Note'], content: 'hi' },
    });
    expect(r.success).toBe(true);
  });

  it('fails on an unknown / unhandled activity type', () => {
    const r = parseInboundActivity({ id: 'https://x/flag/1', type: 'Flag', actor: 'https://x/u', object: 'https://y' });
    expect(r.ok).toBe(false);
  });

  it('fails when the Create object IRI/embed is missing entirely', () => {
    const r = parseInboundActivity({ id: 'https://x/create/2', type: 'Create', actor: 'https://x/u' });
    expect(r.ok).toBe(false);
  });

  it('fails when a wrong-typed payload is fed (e.g. an actor, not an activity)', () => {
    const r = parseInboundActivity({ id: 'https://x/u', type: 'Person', inbox: 'https://x/u/inbox' });
    expect(r.ok).toBe(false);
  });

  it('surfaces a ZodError on failure without throwing', () => {
    const r = parseInboundActivity(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Outbox collection schemas
// ---------------------------------------------------------------------------

describe('apOrderedCollection / apOrderedCollectionPage', () => {
  it('parses a top-level OrderedCollection that paginates via first/last', () => {
    const r = parseOrderedCollection({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: 'https://mastodon.social/users/alice/outbox',
      type: 'OrderedCollection',
      totalItems: 1234,
      first: 'https://mastodon.social/users/alice/outbox?page=true',
      last: 'https://mastodon.social/users/alice/outbox?min_id=0&page=true',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.totalItems).toBe(1234);
  });

  it('parses an OrderedCollection that inlines orderedItems', () => {
    const r = parseOrderedCollection({
      id: 'https://pleroma.example/users/x/outbox',
      type: 'OrderedCollection',
      totalItems: 2,
      orderedItems: [
        { id: 'https://pleroma.example/activities/1', type: 'Create', object: { id: 'https://pleroma.example/objects/1', type: 'Note' } },
        'https://pleroma.example/activities/2',
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.orderedItems).toHaveLength(2);
  });

  it('parses an OrderedCollectionPage with orderedItems + next link', () => {
    const r = parseOrderedCollectionPage({
      id: 'https://mastodon.social/users/alice/outbox?page=true',
      type: 'OrderedCollectionPage',
      partOf: 'https://mastodon.social/users/alice/outbox',
      next: 'https://mastodon.social/users/alice/outbox?max_id=1&page=true',
      orderedItems: [
        { id: 'https://mastodon.social/users/alice/statuses/2/activity', type: 'Announce', object: 'https://other/note/1' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.orderedItems).toHaveLength(1);
  });

  it('parses a CollectionPage whose next is a Link object', () => {
    const r = parseOrderedCollectionPage({
      id: 'https://lemmy.example/c/news/outbox?page=1',
      type: 'OrderedCollectionPage',
      items: ['https://lemmy.example/activities/1'],
      next: { type: 'Link', href: 'https://lemmy.example/c/news/outbox?page=2' },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a non-array orderedItems', () => {
    const r = apOrderedCollectionSchema.safeParse({
      type: 'OrderedCollection',
      orderedItems: 'not-an-array',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-numeric totalItems', () => {
    const r = apOrderedCollectionPageSchema.safeParse({
      type: 'OrderedCollectionPage',
      totalItems: 'many',
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Direct schema export sanity (each exported schema is usable)
// ---------------------------------------------------------------------------

describe('schema exports', () => {
  it('apNoteSchema / apActorSchema / activity schemas are all defined', () => {
    expect(apNoteSchema).toBeDefined();
    expect(apActorSchema).toBeDefined();
    expect(apCreateSchema).toBeDefined();
    expect(apUpdateSchema).toBeDefined();
    expect(apDeleteSchema).toBeDefined();
    expect(apAnnounceSchema).toBeDefined();
    expect(apLikeSchema).toBeDefined();
    expect(apFollowSchema).toBeDefined();
    expect(apAcceptSchema).toBeDefined();
    expect(apUndoSchema).toBeDefined();
    expect(apTombstoneSchema).toBeDefined();
    expect(apOrderedCollectionSchema).toBeDefined();
    expect(apOrderedCollectionPageSchema).toBeDefined();
  });
});
