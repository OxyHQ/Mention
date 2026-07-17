import { describe, it, expect } from 'vitest';

/**
 * The ExternalFeed model — a READ-ONLY reference to a remote (atproto) feed
 * generator. Offline construct → validateSync → index-declaration checks (the repo
 * has no mongodb-memory-server); no DB connection is opened.
 */

import ExternalFeed from '../models/ExternalFeed';

describe('ExternalFeed model', () => {
  it('round-trips a valid feed reference', () => {
    const now = new Date();
    const doc = new ExternalFeed({
      network: 'atproto',
      uri: 'at://did:plc:c/app.bsky.feed.generator/t-news',
      ownerOxyUserId: 'oxy-creator',
      serviceDid: 'did:web:feeds.example.com',
      name: 'T - News',
      description: 'hot news posts',
      likeCount: 12,
      webUrl: 'https://bsky.app/profile/creator.bsky.social/feed/t-news',
      syncedAt: now,
    });
    expect(doc.validateSync()).toBeUndefined();
    const obj = doc.toObject();
    expect(obj.uri).toBe('at://did:plc:c/app.bsky.feed.generator/t-news');
    expect(obj.serviceDid).toBe('did:web:feeds.example.com');
    expect(obj.webUrl).toBe('https://bsky.app/profile/creator.bsky.social/feed/t-news');
  });

  it('requires the load-bearing reference fields', () => {
    const doc = new ExternalFeed({ network: 'atproto' });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    // Missing the fields a reference card cannot render / dedup without.
    for (const field of ['uri', 'ownerOxyUserId', 'serviceDid', 'name', 'webUrl', 'syncedAt']) {
      expect(error?.errors[field]).toBeDefined();
    }
  });

  it('declares a unique index on uri and an owner-lookup index', () => {
    const indexes = ExternalFeed.schema.indexes();
    const uriIndex = indexes.find(([keys]) => Object.prototype.hasOwnProperty.call(keys, 'uri'));
    expect(uriIndex?.[1]).toMatchObject({ unique: true });
    const ownerIndex = indexes.find(
      ([keys]) => keys.ownerOxyUserId === 1 && Object.prototype.hasOwnProperty.call(keys, 'createdAt'),
    );
    expect(ownerIndex).toBeDefined();
  });
});
