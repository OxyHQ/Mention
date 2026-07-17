import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Live "dead federated actor" tombstone: a definitive 410 Gone on the actor fetch
 * marks the stored `FederatedActor` `suspended` and asks oxy-api to archive the
 * linked identity (`reportFederatedActorGone`). Both best-effort and fail-soft —
 * a 410 is authoritative, but the tombstone must never throw out of
 * `fetchRemoteActor`, and a 404/5xx must NOT trigger it (only 410 is definitive).
 */

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  reportFederatedActorGone: vi.fn(),
  signedFetch: vi.fn(),
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: { findOneAndUpdate: mocks.findOneAndUpdate },
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

const ACTOR_URI = 'https://mastodon.social/users/ghost';

/** A `findOneAndUpdate(...).lean()` result stub. */
function leanReturning(value: unknown): { lean: () => Promise<unknown> } {
  return { lean: () => Promise.resolve(value) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reportFederatedActorGone.mockResolvedValue('archived');
});

describe('actorService.tombstoneGoneActor', () => {
  it('suspends the stored row and reports the linked identity gone to Oxy', async () => {
    mocks.findOneAndUpdate.mockReturnValue(leanReturning({ oxyUserId: 'oxy-ghost' }));

    await actorService.tombstoneGoneActor(ACTOR_URI);

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { uri: ACTOR_URI },
      { $set: { suspended: true } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
    expect(mocks.reportFederatedActorGone).toHaveBeenCalledWith('oxy-ghost');
  });

  it('suspends but does NOT report when the actor has no linked Oxy identity', async () => {
    mocks.findOneAndUpdate.mockReturnValue(leanReturning({ oxyUserId: undefined }));

    await actorService.tombstoneGoneActor(ACTOR_URI);

    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.reportFederatedActorGone).not.toHaveBeenCalled();
  });

  it('is a no-op (no report) when no stored actor row matches', async () => {
    mocks.findOneAndUpdate.mockReturnValue(leanReturning(null));

    await actorService.tombstoneGoneActor(ACTOR_URI);

    expect(mocks.reportFederatedActorGone).not.toHaveBeenCalled();
  });

  it('never throws when the Mongo write fails (fail-soft)', async () => {
    mocks.findOneAndUpdate.mockImplementation(() => {
      throw new Error('mongo down');
    });

    await expect(actorService.tombstoneGoneActor(ACTOR_URI)).resolves.toBeUndefined();
    expect(mocks.reportFederatedActorGone).not.toHaveBeenCalled();
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
