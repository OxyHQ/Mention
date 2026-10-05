import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A remote handle that changed hands.
 *
 * `federated_actors.acct` and `(domain, username)` are unique, so when a remote
 * account renames and another takes its old handle (or a deleted account's handle
 * is reused), the cache still holds the OLD owner under it and the new owner's
 * upsert collides. The resolver re-fetches the stale holder instead of giving up:
 * a holder that renamed is refreshed onto its new handle, a gone one (410)
 * releases it, and a holder that still claims it keeps it — the anti-hijack rule
 * the unique constraints exist for.
 *
 * Real Postgres for the actor rows; the network (`signedFetch`) and Oxy (identity
 * resolution, projection) are the doubles.
 */

const mocks = vi.hoisted(() => ({
  signedFetch: vi.fn(),
  resolveOxyIdentity: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/helpers', async () => {
  const actual = await vi.importActual<typeof import('../../../connectors/activitypub/helpers')>(
    '../../../connectors/activitypub/helpers',
  );
  return { ...actual, signedFetch: mocks.signedFetch };
});
vi.mock('../../../connectors/oxyIdentity', () => ({ resolveOxyIdentity: mocks.resolveOxyIdentity }));
vi.mock('../../../connectors/identity', () => ({ reportFederatedActorGone: vi.fn(async () => 'archived') }));
vi.mock('../../../services/ActorIdentityProjectionService', () => ({
  reconcileActorIdentityProjection: vi.fn(async () => ({ postsChanged: 0 })),
}));

import { closePostgres, connectPostgres } from '../../../db/postgres';
import { actorService } from '../../../connectors/activitypub/actor.service';
import { clearFederationScope, federationScope, readActor, seedActor } from '../../helpers/federationFixtures';
import { oxyIdentityFixture } from '../../helpers/oxyIdentityFixtures';

const scope = federationScope('actor-handle-rename');
const OLD_HOLDER = `${scope.origin}/users/1`;
const NEW_OWNER = `${scope.origin}/users/2`;
const HANDLE = `alice@${scope.domain}`;

/** What each actor URI serves: a username, or an HTTP status. */
let served: Record<string, string | number>;

function actorDocument(uri: string, username: string) {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: uri,
    type: 'Person',
    preferredUsername: username,
    inbox: `${uri}/inbox`,
    outbox: `${uri}/outbox`,
  };
}

beforeAll(connectPostgres);
afterAll(closePostgres);

beforeEach(() => {
  vi.clearAllMocks();
  served = {};
  mocks.signedFetch.mockImplementation(async (url: string) => {
    const answer = served[url];
    if (typeof answer === 'string') {
      return new Response(JSON.stringify(actorDocument(url, answer)), {
        status: 200,
        headers: { 'content-type': 'application/activity+json' },
      });
    }
    return new Response('', { status: answer ?? 404 });
  });
  mocks.resolveOxyIdentity.mockImplementation(async ({ actorUri, transportAcct }: { actorUri: string; transportAcct: string }) =>
    oxyIdentityFixture({ actorUri, transportAcct, canonicalAcct: transportAcct, network: scope.domain, userId: `oxy-${actorUri.split('/').pop()}` }));
});

afterEach(async () => {
  await clearFederationScope(scope);
});

describe('a handle the cache still gives to its previous owner', () => {
  it('moves the renamed holder onto its new handle and stores the new owner', async () => {
    await seedActor(scope, { username: 'alice', uri: OLD_HOLDER });
    served[OLD_HOLDER] = 'alice-renamed';
    served[NEW_OWNER] = 'alice';

    const stored = await actorService.fetchRemoteActor(NEW_OWNER);

    expect(stored?.acct).toBe(HANDLE);
    expect((await readActor(NEW_OWNER))?.acct).toBe(HANDLE);
    expect((await readActor(OLD_HOLDER))?.acct).toBe(`alice-renamed@${scope.domain}`);
  });

  it('releases the handle of a holder that is gone (410)', async () => {
    await seedActor(scope, { username: 'alice', uri: OLD_HOLDER });
    served[OLD_HOLDER] = 410;
    served[NEW_OWNER] = 'alice';

    const stored = await actorService.fetchRemoteActor(NEW_OWNER);

    expect(stored?.acct).toBe(HANDLE);
    const gone = await readActor(OLD_HOLDER);
    expect(gone?.suspended).toBe(true);
    expect(gone?.acct).not.toBe(HANDLE);
    // Still the same row, under a spelling no WebFinger handle can have.
    expect(gone?.acct).toMatch(new RegExp(`^alice~gone-.+@${scope.domain.replace('.', '\\.')}$`));
  });

  it('refuses the handle while a live holder still claims it', async () => {
    await seedActor(scope, { username: 'alice', uri: OLD_HOLDER });
    served[OLD_HOLDER] = 'alice';
    served[NEW_OWNER] = 'alice';

    expect(await actorService.fetchRemoteActor(NEW_OWNER)).toBeNull();
    expect(await readActor(NEW_OWNER)).toBeNull();
    expect((await readActor(OLD_HOLDER))?.acct).toBe(HANDLE);
  });

  it('refuses without releasing when the holder is only unreachable (404 is not gone)', async () => {
    await seedActor(scope, { username: 'alice', uri: OLD_HOLDER });
    served[OLD_HOLDER] = 404;
    served[NEW_OWNER] = 'alice';

    expect(await actorService.fetchRemoteActor(NEW_OWNER)).toBeNull();
    expect((await readActor(OLD_HOLDER))?.acct).toBe(HANDLE);
  });
});
