import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An ActivityPub actor's banner follows its source on every refresh.
 *
 * Every AP actor write passes the actor store's upsert, so that is where the
 * banner the actor's `image` advertises is queued for the mirror sweep — and
 * where an `image` the actor removed clears it. Real Postgres for the actor row;
 * the network, Oxy and the banner bookkeeping are the doubles.
 */

const mocks = vi.hoisted(() => ({
  signedFetch: vi.fn(),
  resolveOxyIdentity: vi.fn(),
  syncFederatedBannerInBackground: vi.fn(),
  recordRemoteMove: vi.fn(async () => 'recorded'),
}));

vi.mock('../../../connectors/activitypub/helpers', async () => {
  const actual = await vi.importActual<typeof import('../../../connectors/activitypub/helpers')>(
    '../../../connectors/activitypub/helpers',
  );
  return { ...actual, signedFetch: mocks.signedFetch };
});
vi.mock('../../../connectors/oxyIdentity', async () => {
  const { observeOxySourceDouble } = await import('../../helpers/oxyIdentityFixtures');
  return {
    resolveOxyIdentity: mocks.resolveOxyIdentity,
    // Oxy reads the actor (served by `signedFetch`, the remote double) once.
    observeOxySource: observeOxySourceDouble(mocks.signedFetch, mocks.resolveOxyIdentity),
  };
});
vi.mock('../../../connectors/identity', () => ({
  reportFederatedActorGone: vi.fn(async () => 'archived'),
}));
vi.mock('../../../services/ActorIdentityProjectionService', () => ({
  reconcileActorIdentityProjection: vi.fn(async () => ({ postsChanged: 0 })),
}));
vi.mock('../../../connectors/activitypub/move.service', () => ({
  recordRemoteMove: mocks.recordRemoteMove,
}));
vi.mock('../../../db/federation/bannerMirrorRepository', () => ({
  syncFederatedBannerInBackground: mocks.syncFederatedBannerInBackground,
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { federatedActors } from '../../../db/schema/federation';
import { findActorByUri, setActorMovedTo } from '../../../db/federation/actorRepository';
import { actorService } from '../../../connectors/activitypub/actor.service';
import { clearFederationScope, federationScope } from '../../helpers/federationFixtures';
import { oxyIdentityFixture } from '../../helpers/oxyIdentityFixtures';

const scope = federationScope('actor-banner-sync');
const ACTOR = `${scope.origin}/users/alice`;
const BANNER = `${scope.origin}/media/header.png`;

let image: string | undefined;
let movedTo: string | undefined;
let indexable: boolean | undefined;

beforeAll(connectPostgres);
afterAll(closePostgres);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signedFetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: ACTOR,
          type: 'Person',
          preferredUsername: 'alice',
          inbox: `${ACTOR}/inbox`,
          ...(image && { image: { type: 'Image', url: image } }),
          ...(movedTo && { movedTo }),
          ...(indexable !== undefined && { indexable }),
        }),
        { status: 200, headers: { 'content-type': 'application/activity+json' } },
      ),
  );
  mocks.resolveOxyIdentity.mockImplementation(
    async ({ actorUri, transportAcct }: { actorUri: string; transportAcct: string }) =>
      oxyIdentityFixture({
        actorUri,
        transportAcct,
        canonicalAcct: transportAcct,
        network: scope.domain,
        userId: 'oxy-alice',
      }),
  );
});

afterEach(async () => {
  await clearFederationScope(scope);
});

describe('the actor upsert', () => {
  it('syncs the banner the actor advertises, and its removal', async () => {
    image = BANNER;
    await actorService.fetchRemoteActor(ACTOR);
    expect(mocks.syncFederatedBannerInBackground).toHaveBeenLastCalledWith({
      oxyUserId: 'oxy-alice',
      actorUri: ACTOR,
      bannerUrl: BANNER,
    });

    image = undefined;
    await actorService.fetchRemoteActor(ACTOR);
    expect(mocks.syncFederatedBannerInBackground).toHaveBeenLastCalledWith({
      oxyUserId: 'oxy-alice',
      actorUri: ACTOR,
      bannerUrl: undefined,
    });
  });

  it('verifies a move the actor announces, and clears one it stops announcing', async () => {
    movedTo = `${scope.origin}/users/alice-new`;
    await actorService.fetchRemoteActor(ACTOR);
    expect(mocks.recordRemoteMove).toHaveBeenCalledWith({
      oldActorUri: ACTOR,
      targetActorUri: movedTo,
    });
    // The upsert itself never writes an unverified target.
    expect((await findActorByUri(ACTOR))?.movedTo).toBeUndefined();

    await setActorMovedTo(ACTOR, movedTo);
    movedTo = undefined;
    await actorService.fetchRemoteActor(ACTOR);
    expect((await findActorByUri(ACTOR))?.movedTo).toBeUndefined();
  });

  it('stores the `indexable` the actor states, and NULL once it stops stating it', async () => {
    const stored = async () =>
      (
        await getDb()
          .select({ indexable: federatedActors.indexable })
          .from(federatedActors)
          .where(eq(federatedActors.uri, ACTOR))
      )[0]?.indexable;

    indexable = true;
    await actorService.fetchRemoteActor(ACTOR);
    expect(await stored()).toBe(true);

    indexable = undefined;
    await actorService.fetchRemoteActor(ACTOR);
    expect(await stored()).toBeNull();
  });
});
