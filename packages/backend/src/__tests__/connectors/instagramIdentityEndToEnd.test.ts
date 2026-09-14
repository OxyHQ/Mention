import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Oxy supplies canonical identity; Mention imports source content and renders that exact profile. */

/**
 * The JRD `kilogram.makeup` serves, synthesized from the queried resource rather
 * than pinned to one acct — this suite resolves both a mirrored account and the
 * operator's own, and a fixed JRD would silently answer the second query with
 * the first actor's URI. Byte-shape captured from the live
 * `/.well-known/webfinger?resource=acct:zuck@kilogram.makeup` on 2026-09-11.
 */
const { webFingerJrdFor } = vi.hoisted(() => ({
  webFingerJrdFor: (resource: string) => {
    const acct = resource.replace(/^acct:/, '');
    const [user, host] = acct.split('@');
    const actorUri = `https://${host}/users/${user}`;
    return {
      subject: `acct:${acct}`,
      aliases: [actorUri],
      links: [
        { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: actorUri },
        { rel: 'self', type: 'application/activity+json', href: actorUri },
      ],
    };
  },
}));

const mocks = vi.hoisted(() => ({
  signedFetch: vi.fn(),
  findActorByUri: vi.fn(),
  /** The actor-row write itself — `(uri, columns, fields)`. */
  upsertActor: vi.fn(),
  reconcileProjection: vi.fn().mockResolvedValue({}),
  findIdentityOwnerActor: vi.fn(),
  makeServiceRequest: vi.fn(),
}));

// The signed AP fetch is the only thing replaced in `helpers` — acct
// normalization and domain parsing are part of what is under test.
vi.mock('../../connectors/activitypub/helpers', async () => {
  const actual = await vi.importActual<typeof import('../../connectors/activitypub/helpers')>(
    '../../connectors/activitypub/helpers',
  );
  return { ...actual, signedFetch: mocks.signedFetch };
});

vi.mock('../../utils/safeUpstreamFetch', async () => {
  const actual = await vi.importActual<typeof import('../../utils/safeUpstreamFetch')>(
    '../../utils/safeUpstreamFetch',
  );
  const { Readable } = await import('node:stream');
  return {
    ...actual,
    fetchUpstreamSingleHop: async (url: string) => {
      const resource = new URL(url).searchParams.get('resource') ?? '';
      return {
        response: Readable.from([Buffer.from(JSON.stringify(webFingerJrdFor(resource)))]),
        status: 200,
      };
    },
  };
});

// PARTIAL, and deliberately narrow: only the actor-cache functions this lane
// reaches are replaced, so anything else fails loudly on an absent connection
// rather than quietly answering from a stub nobody wrote.
vi.mock('../../db/federation/actorRepository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/federation/actorRepository')>()),
  findActorByUri: mocks.findActorByUri,
  upsertActor: mocks.upsertActor,
  findIdentityOwnerActor: mocks.findIdentityOwnerActor,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  getServiceOxyClient: () => ({
    makeServiceRequest: mocks.makeServiceRequest,
    getUserById: vi.fn(),
    getUsersByIds: vi.fn(async () => []),
  }),
}));

vi.mock('@oxy.so/core/server', () => ({ getRequiredOxyUserId: () => 'local-user-1' }));
vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
}));
vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(async () => true),
  invalidateFediverseSharing: vi.fn(),
}));
vi.mock('../../services/ActorIdentityProjectionService', () => ({ reconcileActorIdentityProjection: mocks.reconcileProjection }));
vi.mock('../../services/userSummaryCache', () => ({ invalidate: vi.fn() }));
vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: vi.fn(async () => ({ ok: false, permanent: true })),
}));

import connectorsRoutes from '../../connectors/connectors.routes';
import { oxyIdentityFixture } from '../helpers/oxyIdentityFixtures';

const ACTOR_URI = 'https://kilogram.makeup/users/zuck';
const AVATAR = 'https://ipfs.kilogram.makeup/ipfs/Qmbm6jXQnwGErrzkoMhioMtf1Cb8chtFrZ8Kcmg9tQtUuf';

/** Captured live, 2026-09-11. Do not hand-edit — re-capture if the bridge changes shape. */
const LIVE_ACTOR = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  id: ACTOR_URI,
  type: 'Service',
  preferredUsername: 'zuck',
  name: 'Mark Zuckerberg',
  summary:
    "I build stuff<br>This account is a replica from Instagram. Its author can't see your replies. "
    + 'If you find this service useful, please consider supporting us via our Patreon. <br>',
  url: ACTOR_URI,
  inbox: 'https://kilogram.makeup/users/zuck/inbox',
  outbox: 'https://kilogram.makeup/users/zuck/outbox',
  followers: 'https://kilogram.makeup/users/zuck/followers',
  manuallyApprovesFollowers: false,
  discoverable: true,
  icon: { type: 'Image', mediaType: 'image/jpeg', url: AVATAR },
  endpoints: { sharedInbox: 'https://kilogram.makeup/inbox' },
  attachment: [
    {
      type: 'PropertyValue',
      name: '🔗',
      value:
        '<a href="http://meta.com/thefutureisforeveryone" rel="nofollow noopener noreferrer" target="_blank">'
        + '<span class="invisible">http://</span><span class="ellipsis">meta.com/thefutureisforeveryon</span>'
        + '<span class="invisible">e</span></a>',
    },
    {
      type: 'PropertyValue',
      name: 'Official',
      value:
        '<a href="https://www.instagram.com/zuck" rel="me nofollow noopener noreferrer" target="_blank">'
        + '<span class="invisible">https://</span><span class="ellipsis">www.instagram.com/zuck</span></a>',
    },
    {
      type: 'PropertyValue',
      name: 'Support this service',
      value:
        '<a href="https://www.patreon.com/birddotmakeup" rel="me nofollow noopener noreferrer" target="_blank">'
        + '<span class="invisible">https://</span><span class="ellipsis">www.patreon.com/birddotmakeup</span></a>',
    },
    {
      type: 'PropertyValue',
      name: 'Twitter',
      value:
        '<span class="h-card" translate="no"><a href="https://bird.makeup/users/finkd" class="u-url mention">'
        + '@<span>finkd@bird.makeup</span></a></span>',
    },
  ],
};

/**
 * The bridge operator's own service account, which publishes NO `Official` field.
 * It must keep its bridge identity: the derivation is per-actor and fails closed,
 * which is the whole reason an operator account is not re-attributed to a person
 * on Instagram who may not exist.
 */
const OPERATOR_ACTOR = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  id: 'https://kilogram.makeup/users/kilogram.makeup',
  type: 'Service',
  preferredUsername: 'kilogram.makeup',
  name: 'kilogram.makeup',
  summary: 'Instagram to ActivityPub bridge.',
  inbox: 'https://kilogram.makeup/users/kilogram.makeup/inbox',
  outbox: 'https://kilogram.makeup/users/kilogram.makeup/outbox',
  attachment: [],
};

const app = express();
app.use(express.json());
app.use('/federation', connectorsRoutes);

/**
 * The columns the ingest wrote for the actor row, keyed by the `uri` the upsert
 * is addressed to (`upsertActor` takes it positionally and strips it from the
 * column set, so it is put back here — it is the same row either way).
 */
let storedRow: Record<string, unknown>;

function serveActor(document: Record<string, unknown>): void {
  mocks.signedFetch.mockImplementation(async (url: string) =>
    url === document.id
      ? new Response(JSON.stringify(document), {
          status: 200,
          headers: { 'content-type': 'application/activity+json' },
        })
      : new Response('', { status: 404 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  storedRow = {};
  mocks.findActorByUri.mockResolvedValue(null);
  mocks.findIdentityOwnerActor.mockResolvedValue(null);
  mocks.upsertActor.mockImplementation((uri: string, columns: Record<string, unknown>) => {
    storedRow = { uri, ...columns };
    return Promise.resolve({ ...storedRow, id: 'row-1' });
  });
  mocks.makeServiceRequest.mockResolvedValue(oxyIdentityFixture({
    actorUri: ACTOR_URI, transportAcct: 'zuck@kilogram.makeup', canonicalAcct: 'zuck@instagram.com',
    network: 'instagram.com', userId: 'oxy-zuck', displayName: 'Mark Zuckerberg', bio: 'I build stuff', avatar: AVATAR,
  }));
  serveActor(LIVE_ACTOR);
});

describe('resolving @zuck@kilogram.makeup', () => {
  it('refuses discovery if source-scoped identity projection cannot complete', async () => {
    mocks.reconcileProjection.mockResolvedValueOnce({ refusal: 'actor_not_cached' });
    const res = await request(app).get('/federation/resolve').query({ handle: '@zuck@kilogram.makeup' });
    expect(res.body.actor).toBeNull();
    expect(mocks.reconcileProjection).toHaveBeenCalledWith({
      actorUri: 'https://kilogram.makeup/users/zuck', oxyUserId: 'oxy-zuck', networkAcct: 'zuck@instagram.com',
    });
  });

  it('answers with the Instagram identity while keeping the bridge URI addressable', async () => {
    const res = await request(app)
      .get('/federation/resolve')
      .query({ handle: '@zuck@kilogram.makeup' });

    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      network: 'activitypub',
      handle: 'zuck@instagram.com',
      // The protocol id a follow is addressed to. It stays pointed at the
      // bridge, which is what keeps inbox/outbox/follow delivery working.
      externalId: ACTOR_URI,
      oxyUserId: 'oxy-zuck',
      avatarUrl: expect.stringContaining(encodeURIComponent(AVATAR)),
    });
    expect(JSON.stringify(res.body.actor.handle)).not.toContain('kilogram.makeup');
  });

  it('asks Oxy to discover the person without sending app-derived profile assertions', async () => {
    await request(app).get('/federation/resolve').query({ handle: '@zuck@kilogram.makeup' });
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', {
      handle: '@zuck@kilogram.makeup',
    });
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', {
      actorUri: ACTOR_URI, transportAcct: 'zuck@kilogram.makeup', protocol: 'activitypub',
    });
    expect(mocks.makeServiceRequest.mock.calls.some(([, path]) => path === '/users/resolve')).toBe(false);
    expect(mocks.findIdentityOwnerActor).not.toHaveBeenCalled();
  });

  it('keeps the bridge address on the row it holds for reaching the actor', async () => {
    await request(app).get('/federation/resolve').query({ handle: '@zuck@kilogram.makeup' });

    expect(storedRow).toMatchObject({
      acct: 'zuck@kilogram.makeup',
      domain: 'kilogram.makeup',
      networkAcct: 'zuck@instagram.com',
    });
  });

  it("strips the bridge's own notice without taking the account's bio with it", async () => {
    await request(app).get('/federation/resolve').query({ handle: '@zuck@kilogram.makeup' });

    expect(storedRow.summary).toBe('I build stuff');
  });
});

describe('the three addresses that must converge on one account', () => {
  it('resolves the network identity a reader would type back', async () => {
    const res = await request(app)
      .get('/federation/resolve')
      .query({ handle: '@zuck@instagram.com' });

    expect(res.body.actor).toMatchObject({ handle: 'zuck@instagram.com', externalId: ACTOR_URI });
  });

  it.each([
    'https://instagram.com/zuck',
    'https://www.instagram.com/zuck',
    'https://www.instagram.com/zuck/',
  ])('resolves the pasted profile link %s', async (url) => {
    const res = await request(app).get('/federation/resolve').query({ handle: url });

    expect(res.body.actor).toMatchObject({ handle: 'zuck@instagram.com', externalId: ACTOR_URI });
  });

  it('never fetches instagram.com itself — the pasted URL is a claim, not a destination', async () => {
    await request(app).get('/federation/resolve').query({ handle: 'https://www.instagram.com/zuck' });

    for (const [url] of mocks.signedFetch.mock.calls) {
      expect(String(url)).not.toContain('instagram.com');
    }
  });
});

describe('what the bridge lane deliberately leaves alone', () => {
  it('uses Oxy canonical identity and bio on the first discovery of an unknown bird.makeup actor', async () => {
    const actorUri = 'https://bird.makeup/users/jordievole';
    serveActor({ ...LIVE_ACTOR, id: actorUri, preferredUsername: 'jordievole',
      inbox: `${actorUri}/inbox`, outbox: `${actorUri}/outbox`,
      summary: "Uno @delbarriotv y de @lodeevole<br>This account is a replica from Twitter. Patreon.",
    });
    mocks.makeServiceRequest.mockResolvedValue(oxyIdentityFixture({
      actorUri, transportAcct: 'jordievole@bird.makeup', canonicalAcct: 'jordievole@x.com',
      network: 'x.com', userId: 'oxy-jordievole', bio: 'Uno @delbarriotv@x.com y de @lodeevole@x.com',
    }));

    expect(storedRow).toEqual({});
    const first = await request(app).get('/federation/resolve').query({ handle: 'jordievole@bird.makeup' });
    expect(first.body.actor).toMatchObject({ handle: 'jordievole@x.com', oxyUserId: 'oxy-jordievole', externalId: actorUri });
    expect(storedRow).toMatchObject({ networkAcct: 'jordievole@x.com',
      summary: 'Uno @delbarriotv@x.com y de @lodeevole@x.com', acct: 'jordievole@bird.makeup',
    });
    const repeated = await request(app).get('/federation/resolve').query({ handle: 'jordievole@bird.makeup' });
    expect(repeated.body.actor).toEqual(first.body.actor);
  });

  it('does not mint a transport identity when Oxy is unavailable', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('Oxy unavailable'));
    const response = await request(app).get('/federation/resolve').query({ handle: 'zuck@kilogram.makeup' });
    expect(response.status).toBe(500);
    expect(mocks.upsertActor).not.toHaveBeenCalled();
    expect(mocks.findIdentityOwnerActor).not.toHaveBeenCalled();
  });

  it("does not re-attribute the operator's own account to a person on Instagram", async () => {
    serveActor(OPERATOR_ACTOR);
    mocks.makeServiceRequest.mockResolvedValue(oxyIdentityFixture({
      actorUri: OPERATOR_ACTOR.id, transportAcct: 'kilogram.makeup@kilogram.makeup',
      canonicalAcct: 'kilogram.makeup@kilogram.makeup', network: 'kilogram.makeup',
      userId: 'oxy-operator', bio: OPERATOR_ACTOR.summary,
    }));

    const res = await request(app)
      .get('/federation/resolve')
      .query({ handle: '@kilogram.makeup@kilogram.makeup' });

    expect(res.body.actor.handle).toBe('kilogram.makeup@kilogram.makeup');
    expect(storedRow.networkAcct).toBe('kilogram.makeup@kilogram.makeup');
    expect(storedRow.summary).toBe(OPERATOR_ACTOR.summary);
  });
});
