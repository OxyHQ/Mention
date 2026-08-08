import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /federation/resolve` given a PASTED PROFILE URL.
 *
 * A reader pastes `https://x.com/elonmusk`. There is no handle to classify and no
 * connector that owns x.com, so the query takes its own lane: derive the accts
 * the reviewed bridges would hold that account under, ask them in order, and keep
 * the first answer that turns out to BE that account.
 *
 * Three properties this route must never lose, each one a way the lane could
 * quietly become something else:
 *
 *  - the pasted URL is never handed to a connector, so it is never fetched;
 *  - only hosts from the committed bridge policy are contacted;
 *  - an actor that did not re-label onto the pasted account is not that account,
 *    however plausibly the acct we guessed resolved.
 */

const { resolve, classifyQuery, getUserById } = vi.hoisted(() => ({
  resolve: vi.fn(),
  classifyQuery: vi.fn(() => 'activitypub' as const),
  getUserById: vi.fn(),
}));

// Same isolation strategy as `connectorsRoutesSharingGate.test.ts`: the route
// module transitively imports the server entrypoint and the full connector
// registry graph — stub the heavy/circular deps so it loads standalone. The
// bridge policy itself is deliberately NOT stubbed: which hosts are asked is the
// thing under test, and a stubbed policy would test a list nobody reviewed.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById }),
}));

vi.mock('@oxyhq/core/server', () => ({
  getRequiredOxyUserId: () => 'local-user-1',
}));

vi.mock('../../connectors/activitypub/constants', () => ({
  FEDERATION_ENABLED: true,
  isBlockedDomain: () => false,
  FEDERATION_DOMAIN: 'mention.earth',
  AP_CONTENT_TYPE: 'application/activity+json',
  USER_AGENT: 'Mention/mention.earth (ActivityPub)',
  resolveOxyUser: vi.fn(),
  FEDERATION_BLOCKS: [],
  federationUrls: {
    actor: (u: string) => `https://mention.earth/ap/users/${u}`,
    inbox: (u: string) => `https://mention.earth/ap/users/${u}/inbox`,
    outbox: (u: string) => `https://mention.earth/ap/users/${u}/outbox`,
    featured: (u: string) => `https://mention.earth/ap/users/${u}/collections/featured`,
    followers: (u: string) => `https://mention.earth/ap/users/${u}/followers`,
    following: (u: string) => `https://mention.earth/ap/users/${u}/following`,
    sharedInbox: () => 'https://mention.earth/ap/inbox',
  },
}));
vi.mock('../../connectors/atproto/constants', () => ({
  ATPROTO_ENABLED: false,
  isDid: (v: string) => v.startsWith('did:'),
  isAtUri: (v: string) => v.startsWith('at://'),
  isAtprotoHandle: () => false,
}));

vi.mock('../../connectors/index', () => ({
  connectorRegistry: {
    list: () => [],
    connectorFor: vi.fn(() => undefined),
    resolve: (...args: unknown[]) => resolve(...args),
  },
}));
vi.mock('../../connectors/resolve', () => ({ classifyQuery }));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {},
  isPermanentlyUnavailableOutboxReason: vi.fn(() => false),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  getServiceOxyClient: () => ({ getUserById }),
}));

vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(async () => true),
}));

import connectorsRoutes from '../../connectors/connectors.routes';

const app = express();
app.use(express.json());
app.use('/federation', connectorsRoutes);

/** A resolved actor as the bridge's row normalizes — re-labelled onto X. */
function bridgedActor(federatedUsername: string, acct: string) {
  return {
    network: 'activitypub' as const,
    externalId: `https://${acct.slice(acct.indexOf('@') + 1)}/users/${acct.slice(0, acct.indexOf('@'))}`,
    handle: acct,
    federatedUsername,
    instanceDomain: federatedUsername.slice(federatedUsername.indexOf('@') + 1),
    oxyUserId: 'oxy-user-1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  classifyQuery.mockReturnValue('activitypub');
  resolve.mockResolvedValue(null);
});

describe('GET /federation/resolve — a pasted profile URL', () => {
  it('reaches the account through the bridge that mirrors its network', async () => {
    resolve.mockImplementation(async (acct: string) =>
      acct === 'elonmusk@bird.makeup' ? bridgedActor('elonmusk@x.com', acct) : null);

    const res = await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      network: 'activitypub',
      // The account, not the bridge it was reached through. `externalId` keeps
      // the protocol id, which is what the follow is addressed to.
      handle: 'elonmusk@x.com',
      externalId: 'https://bird.makeup/users/elonmusk',
      oxyUserId: 'oxy-user-1',
    });
    expect(res.body.actor.handle).not.toContain('bird.makeup');
    expect(resolve).toHaveBeenCalledWith('elonmusk@bird.makeup');
  });

  it('never hands the pasted URL to a connector, and never classifies it as a handle', async () => {
    // Fetching a user-supplied URL is the whole surface this lane exists to
    // avoid: every host contacted comes from our own policy, and the pasted
    // value only ever contributes the handle inside a derived acct.
    await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    expect(resolve).toHaveBeenCalled();
    for (const [subject] of resolve.mock.calls) {
      expect(subject).not.toContain('://');
      expect(subject).toMatch(/^elonmusk@(bird\.makeup|mastox\.eu)$/);
    }
    expect(classifyQuery).not.toHaveBeenCalled();
  });

  it('tries the next reviewed bridge when the first has no copy', async () => {
    resolve.mockImplementation(async (acct: string) =>
      acct === 'elonmusk@mastox.eu' ? bridgedActor('elonmusk@x.com', acct) : null);

    const res = await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    expect(res.status).toBe(200);
    // Which bridge answered is an implementation detail of how we reached the
    // account, and it must not reach the reader as the account's name.
    expect(res.body.actor.handle).toBe('elonmusk@x.com');
    expect(resolve.mock.calls.map(([acct]) => acct)).toEqual(['elonmusk@bird.makeup', 'elonmusk@mastox.eu']);
  });

  it('stops at the first answer instead of ingesting a copy from every bridge', async () => {
    resolve.mockImplementation(async (acct: string) => bridgedActor('elonmusk@x.com', acct));

    await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('drops an actor that turns out to be a different account', async () => {
    // `<handle>@<bridge-host>` is a derivation from how a bridge names its
    // mirrors, not something the actor asserts. When it lands on somebody else —
    // the operator's own account is the obvious case — that is not the pasted
    // account, however well the acct resolved.
    resolve.mockImplementation(async (acct: string) => bridgedActor('someone.else@x.com', acct));

    const res = await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    expect(res.status).toBe(200);
    expect(res.body.actor).toBeNull();
    // Every reviewed bridge was still asked — a wrong answer from one is not an
    // answer about the others.
    expect(resolve.mock.calls.map(([acct]) => acct)).toEqual(['elonmusk@bird.makeup', 'elonmusk@mastox.eu']);
  });

  it('drops an actor the bridge never re-labelled at all', async () => {
    // An actor that does not satisfy its bridge's rule keeps the bridge identity
    // — by design, since that is how the operator's own accounts are left alone.
    resolve.mockImplementation(async (acct: string) => bridgedActor(acct, acct));

    const res = await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    expect(res.status).toBe(200);
    expect(res.body.actor).toBeNull();
  });

  it('answers a plain no-match for a URL on a host no reviewed bridge covers, without asking anyone', async () => {
    const res = await request(app)
      .get('/federation/resolve')
      .query({ handle: 'https://mastodon.social/@Gargron' });

    expect(res.status).toBe(200);
    expect(res.body.actor).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('still resolves an ordinary handle query verbatim', async () => {
    resolve.mockResolvedValue(bridgedActor('alice@mastodon.social', 'alice@mastodon.social'));

    const res = await request(app)
      .get('/federation/resolve')
      .query({ handle: '@alice@mastodon.social' });

    expect(res.status).toBe(200);
    expect(res.body.actor.handle).toBe('alice@mastodon.social');
    expect(resolve).toHaveBeenCalledWith('@alice@mastodon.social');
    expect(classifyQuery).toHaveBeenCalledWith('@alice@mastodon.social');
  });

  it('returns the stored identity for an atproto handle, not the DNS handle it was queried by', async () => {
    // Not a bridge case, and it was wrong in the same way: a default Bluesky
    // handle ADDRESSES `alice.bsky.social` and is STORED as `alice@bsky.social`,
    // so returning the address left the resolved row unable to match the Oxy row
    // for the same person — a duplicate in the results for every default-handle
    // Bluesky account already ingested.
    resolve.mockResolvedValue({
      network: 'atproto' as const,
      externalId: 'did:plc:z72i7hdynmk6r22z27h6tvur',
      handle: 'alice.bsky.social',
      federatedUsername: 'alice@bsky.social',
      instanceDomain: 'bsky.social',
      oxyUserId: 'oxy-user-2',
    });

    const res = await request(app).get('/federation/resolve').query({ handle: 'alice.bsky.social' });

    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      handle: 'alice@bsky.social',
      externalId: 'did:plc:z72i7hdynmk6r22z27h6tvur',
    });
  });

  it('still refuses a local username without asking a connector, with a plain no-match', async () => {
    classifyQuery.mockReturnValue('local');

    const res = await request(app).get('/federation/resolve').query({ handle: '@nate' });

    expect(res.status).toBe(200);
    expect(res.body.actor).toBeNull();
    // The load-bearing half: a local handle is answered WITHOUT touching a
    // connector. `actor: null` alone would also be produced by asking one and
    // getting nothing, which is a different thing costing a network round trip
    // on every keystroke that types a local name.
    expect(resolve).not.toHaveBeenCalled();
  });
});
