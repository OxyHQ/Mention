import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getKeyPair: vi.fn(),
  signRequest: vi.fn(),
  actorFind: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  postFind: vi.fn(),
  postInsertMany: vi.fn(),
  postExists: vi.fn(),
  getServiceOxyClient: vi.fn(),
  makeServiceRequest: vi.fn(),
}));

vi.mock('../../utils/federation/crypto', () => ({
  getKeyPair: mocks.getKeyPair,
  signRequest: mocks.signRequest,
}));

vi.mock('../../models/FederatedActor', () => ({
  default: {
    findOne: vi.fn(),
    find: mocks.actorFind,
    findOneAndUpdate: mocks.findOneAndUpdate,
    updateOne: mocks.updateOne,
  },
}));

vi.mock('../../models/FederatedFollow', () => ({
  default: {},
}));

vi.mock('../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  Post: {
    find: mocks.postFind,
    exists: mocks.postExists,
    collection: {
      insertMany: mocks.postInsertMany,
    },
  },
}));

vi.mock('../../models/UserSettings', () => ({
  default: {
    updateOne: vi.fn(),
  },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
}));

import { federationService } from '../../services/FederationService';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
    ...init,
  });
}

function createNoteActivity(id: string, actorUri = 'https://mastodon.social/users/alice') {
  return {
    id: `${actorUri}/statuses/${id}/activity`,
    type: 'Create',
    actor: actorUri,
    published: `2026-06-18T00:00:0${id}Z`,
    object: {
      id: `${actorUri}/statuses/${id}`,
      type: 'Note',
      attributedTo: actorUri,
      content: `<p>post ${id}</p>`,
      published: `2026-06-18T00:00:0${id}Z`,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getKeyPair.mockResolvedValue({
    keyId: 'https://oxy.so/ap/users/instance#main-key',
    publicKeyPem: 'public',
    privateKeyPem: 'private',
  });
  mocks.signRequest.mockReturnValue({
    Host: 'www.threads.net',
    Date: 'Thu, 18 Jun 2026 00:00:00 GMT',
    Signature: 'signature',
  });
  mocks.findOneAndUpdate.mockImplementation(async (_query, update) => ({
    _id: 'actor_1',
    ...update.$set,
  }));
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.actorFind.mockReturnValue({
    lean: vi.fn().mockResolvedValue([]),
  });
  mocks.postFind.mockReturnValue({
    lean: vi.fn().mockResolvedValue([]),
  });
  mocks.postInsertMany.mockResolvedValue({ insertedCount: 0 });
  mocks.postExists.mockResolvedValue(null);
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getServiceOxyClient.mockReturnValue({
    makeServiceRequest: mocks.makeServiceRequest,
  });
});

describe('federationService.fetchRemoteActor', () => {
  it('preserves canonical www hostnames such as Threads actor URIs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://www.threads.net/ap/users/mosseri/') {
        return jsonResponse({
          id: 'https://www.threads.net/ap/users/mosseri/',
          type: 'Person',
          preferredUsername: 'mosseri',
          name: 'Adam Mosseri',
          inbox: 'https://www.threads.net/ap/users/mosseri/inbox',
          outbox: 'https://www.threads.net/ap/users/mosseri/outbox',
          publicKey: {
            id: 'https://www.threads.net/ap/users/mosseri/#main-key',
            publicKeyPem: 'remote-public',
          },
        });
      }

      if (url === 'https://www.threads.net/ap/users/mosseri/outbox') {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 12 });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const actor = await federationService.fetchRemoteActor(
      'https://www.threads.net/ap/users/mosseri/',
      false,
      'mosseri@threads.net',
    );

    expect(actor?.uri).toBe('https://www.threads.net/ap/users/mosseri/');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.threads.net/ap/users/mosseri/',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: expect.stringContaining('application/activity+json'),
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('https://threads.net/ap/users/mosseri/'),
      expect.anything(),
    );
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { uri: 'https://www.threads.net/ap/users/mosseri/' },
      expect.objectContaining({
        $set: expect.objectContaining({
          uri: 'https://www.threads.net/ap/users/mosseri/',
          acct: 'mosseri@threads.net',
          domain: 'threads.net',
          outboxUrl: 'https://www.threads.net/ap/users/mosseri/outbox',
        }),
      }),
      expect.anything(),
    );
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
      'PUT',
      '/users/resolve',
      expect.objectContaining({
        username: 'mosseri@threads.net',
        actorUri: 'https://www.threads.net/ap/users/mosseri/',
        domain: 'threads.net',
      }),
    );
  });
});

describe('federationService.syncOutboxPostsDetailed', () => {
  it('does not stamp cooldown for non-empty outboxes that expose no importable pages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://www.threads.net/ap/users/mosseri/outbox/') {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 2169,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed({
      uri: 'https://www.threads.net/ap/users/mosseri/',
      acct: 'mosseri@threads.net',
      outboxUrl: 'https://www.threads.net/ap/users/mosseri/outbox/',
      oxyUserId: 'oxy_user_threads',
    });

    expect(result).toMatchObject({
      syncedCount: 0,
      shouldStampCooldown: false,
      reason: 'non-empty-outbox-without-items',
      candidateCount: 0,
      reachedEnd: false,
    });
  });

  it('returns a page cursor with item offset when a backfill batch stops mid-page', async () => {
    const outboxUrl = 'https://mastodon.social/users/alice/outbox';
    const firstPageUrl = 'https://mastodon.social/users/alice/outbox?page=true';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 3,
          first: firstPageUrl,
        });
      }
      if (url === firstPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: firstPageUrl,
          next: 'https://mastodon.social/users/alice/outbox?max_id=3&page=true',
          orderedItems: [
            createNoteActivity('1'),
            createNoteActivity('2'),
            createNoteActivity('3'),
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed(
      {
        uri: 'https://mastodon.social/users/alice',
        acct: 'alice@mastodon.social',
        outboxUrl,
        oxyUserId: 'oxy_user_alice',
      },
      { limit: 2, maxPages: 1 },
    );

    expect(result).toMatchObject({
      syncedCount: 2,
      shouldStampCooldown: true,
      candidateCount: 2,
      newPostCount: 2,
      nextCursor: { url: firstPageUrl, itemOffset: 2 },
      reachedEnd: false,
    });
    expect(mocks.postInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ federation: expect.objectContaining({ activityId: 'https://mastodon.social/users/alice/statuses/1' }) }),
        expect.objectContaining({ federation: expect.objectContaining({ activityId: 'https://mastodon.social/users/alice/statuses/2' }) }),
      ]),
      { ordered: false },
    );
  });

  it('continues from a stored page cursor and offset', async () => {
    const outboxUrl = 'https://mastodon.social/users/alice/outbox';
    const firstPageUrl = 'https://mastodon.social/users/alice/outbox?page=true';
    const secondPageUrl = 'https://mastodon.social/users/alice/outbox?max_id=3&page=true';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 4,
          first: firstPageUrl,
        });
      }
      if (url === firstPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: firstPageUrl,
          next: secondPageUrl,
          orderedItems: [
            createNoteActivity('1'),
            createNoteActivity('2'),
            createNoteActivity('3'),
          ],
        });
      }
      if (url === secondPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: secondPageUrl,
          orderedItems: [
            createNoteActivity('4'),
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed(
      {
        uri: 'https://mastodon.social/users/alice',
        acct: 'alice@mastodon.social',
        outboxUrl,
        oxyUserId: 'oxy_user_alice',
      },
      {
        limit: 2,
        maxPages: 2,
        startPageUrl: firstPageUrl,
        startItemOffset: 2,
      },
    );

    expect(result).toMatchObject({
      syncedCount: 2,
      shouldStampCooldown: true,
      candidateCount: 2,
      newPostCount: 2,
      reachedEnd: true,
    });
    expect(result.nextCursor).toBeUndefined();
    expect(mocks.postInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ federation: expect.objectContaining({ activityId: 'https://mastodon.social/users/alice/statuses/3' }) }),
        expect.objectContaining({ federation: expect.objectContaining({ activityId: 'https://mastodon.social/users/alice/statuses/4' }) }),
      ]),
      { ordered: false },
    );
  });
});
