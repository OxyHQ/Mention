import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  readActor,
  seedActor,
} from '../../helpers/federationFixtures';

const scope = federationScope('actor-tombstone');

/**
 * Live "dead federated actor" tombstone: a definitive 410 Gone on the actor fetch
 * marks the stored actor row `suspended` and asks oxy-api to archive the
 * linked identity (`reportFederatedActorGone`). Both best-effort and fail-soft —
 * a 410 is authoritative, but the tombstone must never throw out of
 * `fetchRemoteActor`, and a 404/5xx must NOT trigger it (only 410 is definitive).
 */

const mocks = vi.hoisted(() => ({
  reportFederatedActorGone: vi.fn(),
  signedFetch: vi.fn(),
}));

vi.mock('../../../connectors/identity', () => ({
  reportFederatedActorGone: mocks.reportFederatedActorGone,
  resolveOxyExternalUser: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/helpers', () => ({
  signedFetch: mocks.signedFetch,
  firstStringUrl: vi.fn(),
  normalizeFederatedAcct: vi.fn(),
  domainFromAcct: vi.fn(),
}));

import { actorService } from '../../../connectors/activitypub/actor.service';

const ACTOR_URI = `${scope.origin}/users/ghost`;

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
  mocks.reportFederatedActorGone.mockResolvedValue('archived');
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('actorService.tombstoneGoneActor', () => {
  it('suspends the stored row and reports the linked identity gone to Oxy', async () => {
    await seedActor(scope, { username: 'ghost', uri: ACTOR_URI, oxyUserId: 'oxy-ghost' });

    await actorService.tombstoneGoneActor(ACTOR_URI);

    // The ROW is suspended — the previous version asserted only that
    // `findOneAndUpdate` had been called with a `$set`, which a write that never
    // reached the database satisfies just as well.
    expect((await readActor(ACTOR_URI))?.suspended).toBe(true);
    expect(mocks.reportFederatedActorGone).toHaveBeenCalledWith('oxy-ghost');
  });

  it('suspends but does NOT report when the actor has no linked Oxy identity', async () => {
    await seedActor(scope, { username: 'ghost', uri: ACTOR_URI, oxyUserId: null });

    await actorService.tombstoneGoneActor(ACTOR_URI);

    expect((await readActor(ACTOR_URI))?.suspended).toBe(true);
    expect(mocks.reportFederatedActorGone).not.toHaveBeenCalled();
  });

  it('is a no-op (no report) when no stored actor row matches', async () => {
    // No row seeded at all.
    await actorService.tombstoneGoneActor(ACTOR_URI);

    expect(await readActor(ACTOR_URI)).toBeNull();
    expect(mocks.reportFederatedActorGone).not.toHaveBeenCalled();
  });

  it('never throws when the database write fails (fail-soft)', async () => {
    await seedActor(scope, { username: 'ghost', uri: ACTOR_URI, oxyUserId: 'oxy-ghost' });
    // The store adapter is the seam that can fail; a closed pool reproduces the
    // "database unavailable mid-tombstone" case without a fake in the query path.
    await closePostgres();

    await expect(actorService.tombstoneGoneActor(ACTOR_URI)).resolves.toBeUndefined();
    expect(mocks.reportFederatedActorGone).not.toHaveBeenCalled();

    await connectPostgres();
  });
});

describe('fetchRemoteActor 410 detection', () => {
  it('tombstones and returns null on a definitive 410 Gone', async () => {
    mocks.signedFetch.mockResolvedValue(new Response('gone', { status: 410 }));
    const tombstoneSpy = vi.spyOn(actorService, 'tombstoneGoneActor').mockResolvedValue(undefined);

    const result = await actorService.fetchRemoteActor(ACTOR_URI);

    expect(result).toBeNull();
    expect(tombstoneSpy).toHaveBeenCalledWith(ACTOR_URI);
    tombstoneSpy.mockRestore();
  });

  it('does NOT tombstone on a 404 (transient — not definitive gone)', async () => {
    mocks.signedFetch.mockResolvedValue(new Response('not found', { status: 404 }));
    const tombstoneSpy = vi.spyOn(actorService, 'tombstoneGoneActor').mockResolvedValue(undefined);

    await actorService.fetchRemoteActor(ACTOR_URI);

    expect(tombstoneSpy).not.toHaveBeenCalled();
    tombstoneSpy.mockRestore();
  });
});
