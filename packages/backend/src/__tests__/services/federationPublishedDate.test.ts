import { describe, it, expect } from 'vitest';
import { Post } from '../../models/Post';
import { PostType, PostVisibility } from '@mention/shared-types';
import { parseApPublished } from '../../services/federation/sharedFederationHelpers';

/**
 * Federated posts MUST preserve their ORIGINAL ActivityPub `published` date as
 * the post's `createdAt`, not the time our server synced them. This guards the
 * two ingredients of that contract:
 *
 *  1. `parseApPublished` correctly maps a valid AP `published` string to a Date
 *     and rejects missing / unparseable / implausibly-future values (so callers
 *     fall back to the schema default — now).
 *
 *  2. The real `Post` Mongoose schema (which enables `timestamps`) HONORS a
 *     `createdAt` supplied on a NEW document instead of overwriting it with the
 *     current time. This is the load-bearing detail: in Mongoose 9 the
 *     timestamps plugin only fills `createdAt` when it is ABSENT on save
 *     (`!doc.$__getValue(createdAt)`). We verify the observable preconditions of
 *     that guard against the ACTUAL Post schema, with no DB connection: the
 *     schema declares named timestamp paths, and a document built with a past
 *     `createdAt` retains it and reports it as modified (so the save-time guard
 *     sees it as present and leaves it untouched).
 */

describe('parseApPublished', () => {
  it('maps a valid ISO 8601 published string to a Date', () => {
    const result = parseApPublished('2023-04-01T12:00:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe('2023-04-01T12:00:00.000Z');
  });

  it('trims surrounding whitespace before parsing', () => {
    const result = parseApPublished('  2020-01-15T08:30:00.000Z  ');
    expect(result?.toISOString()).toBe('2020-01-15T08:30:00.000Z');
  });

  it('returns undefined for a missing/non-string value (falls back to now)', () => {
    expect(parseApPublished(undefined)).toBeUndefined();
    expect(parseApPublished(null)).toBeUndefined();
    expect(parseApPublished(1680350400000)).toBeUndefined();
    expect(parseApPublished('')).toBeUndefined();
    expect(parseApPublished('   ')).toBeUndefined();
  });

  it('returns undefined for an unparseable date string', () => {
    expect(parseApPublished('not-a-date')).toBeUndefined();
    expect(parseApPublished('2023-13-99T99:99:99Z')).toBeUndefined();
  });

  it('rejects an implausibly-future date (beyond the 24h skew window)', () => {
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    expect(parseApPublished(farFuture)).toBeUndefined();
  });

  it('accepts a slightly-future date within the skew window', () => {
    const nearFuture = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // +1h
    expect(parseApPublished(nearFuture)).toBeInstanceOf(Date);
  });
});

describe('Post schema timestamps honor a provided createdAt (federated ingest)', () => {
  const PAST = new Date('2021-09-01T10:00:00.000Z');

  // The IPost interface types createdAt/updatedAt as ISO strings (the serialized
  // read shape), but the underlying schema stores Date instances — read them
  // through `Date` for the timestamp assertions.
  function readDate(doc: { get(path: string): unknown }, path: string): Date {
    const value = doc.get(path);
    expect(value).toBeInstanceOf(Date);
    return value as Date;
  }

  it('declares named timestamp paths so a provided createdAt is honored on save', () => {
    // Mongoose 9's save-time timestamp guard fills createdAt ONLY when the named
    // path is absent (`!doc.$__getValue(createdAt)`). Confirm the path is named
    // 'createdAt' (the precondition the federated-insert override depends on).
    const timestampsOption = Post.schema.options.timestamps;
    expect(timestampsOption).toMatchObject({ createdAt: 'createdAt', updatedAt: 'updatedAt' });
  });

  it('a federated post built with a past createdAt retains it and marks it modified', () => {
    const post = new Post({
      oxyUserId: 'federated_user_1',
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      content: { text: 'A federated note authored in the past', media: [] },
      federation: { activityId: 'https://mastodon.social/users/alice/statuses/1' },
      createdAt: PAST,
      updatedAt: PAST,
    });

    // Present + modified → the save-time guard sees createdAt as set and leaves
    // it untouched (does NOT overwrite with now).
    expect(post.isNew).toBe(true);
    expect(post.isModified('createdAt')).toBe(true);
    expect(readDate(post, 'createdAt').toISOString()).toBe(PAST.toISOString());
    expect(readDate(post, 'updatedAt').toISOString()).toBe(PAST.toISOString());
  });

  it('a native post built without createdAt leaves the path unset for save() to fill', () => {
    const post = new Post({
      oxyUserId: 'local_user_1',
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      content: { text: 'A native post', media: [] },
    });

    // Absent → the save-time guard fills it with the current time (verified
    // empirically against mongoose 9.3.1's setDocumentTimestamps helper).
    expect(post.get('createdAt')).toBeUndefined();
  });
});
