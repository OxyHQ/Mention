import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';

/** Oxy supplies canonical identity; Mention imports source content and renders that exact profile. */

const mocks = vi.hoisted(() => ({
  serviceRequest: vi.fn(),
  persistRemoteMedia: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    serviceRequest: mocks.serviceRequest,
  }),
}));

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

import { reportFederatedActorGone } from '../../connectors/identity';
import { observeOxySource } from '../../connectors/oxyIdentity';
import { oxyIdentityFixture } from '../helpers/oxyIdentityFixtures';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userSettings } from '../../db/schema/userProfile';

/** Every settings row these cases create, so cleanup reaches exactly them. */
const settingsOwners = ['oxy-resolved', 'oxy-bob'];

/** Build an HTTP-style rejection carrying the flat `.status` shape `getErrorStatus` reads. */
function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

beforeAll(async () => {
  // The banner write is a real `user_settings` row now, so this suite needs the
  // database it writes to.
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serviceRequest.mockResolvedValue({ _id: 'oxy-resolved' });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false, reason: 'disabled' });
});

afterEach(async () => {
  await getDb().delete(userSettings).where(inArray(userSettings.oxyUserId, settingsOwners));
});

afterAll(async () => {
  await closePostgres();
});

describe('observeOxySource', () => {
  const actorUri = 'https://bird.makeup/users/alice';

  it('returns the document Oxy verified with the identity, asking Oxy only for the source actor', async () => {
    const sourceDocument = { id: actorUri, inbox: `${actorUri}/inbox` };
    mocks.serviceRequest.mockResolvedValue({
      ...oxyIdentityFixture({
        actorUri,
        transportAcct: 'alice@bird.makeup',
        canonicalAcct: 'alice@x.com',
        network: 'x.com',
      }),
      sourceDocument,
    });

    const observed = await observeOxySource({ actorUri, protocol: 'activitypub' });

    expect(observed).toMatchObject({ status: 200, resolved: { sourceDocument } });
    expect(mocks.serviceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', {
      actorUri,
      protocol: 'activitypub',
    });
    expect(mocks.persistRemoteMedia).not.toHaveBeenCalled();
  });

  it("reports the source's own refusal, so a gone actor is told apart", async () => {
    mocks.serviceRequest.mockRejectedValue(
      Object.assign(httpError(404), { details: { sourceStatus: 410 } }),
    );
    expect(await observeOxySource({ actorUri, protocol: 'activitypub' })).toEqual({ status: 410 });

    mocks.serviceRequest.mockRejectedValue(httpError(503));
    await expect(observeOxySource({ actorUri, protocol: 'activitypub' })).rejects.toThrow();
  });
});

describe('reportFederatedActorGone', () => {
  it('posts to /federation/actor-gone with the oxyUserId and returns "archived"', async () => {
    mocks.serviceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      accountStatus: 'archived',
      alreadyArchived: false,
    });

    const outcome = await reportFederatedActorGone('6981c9178fcdefaf81988ffb');

    expect(outcome).toBe('archived');
    expect(mocks.serviceRequest).toHaveBeenCalledWith('POST', '/federation/actor-gone', {
      oxyUserId: '6981c9178fcdefaf81988ffb',
    });
  });

  it('returns "already" when Oxy reports the identity was already archived (idempotent 200)', async () => {
    mocks.serviceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      accountStatus: 'archived',
      alreadyArchived: true,
    });

    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('already');
  });

  it('returns "skipped" without any network call for an empty id', async () => {
    expect(await reportFederatedActorGone('   ')).toBe('skipped');
    expect(mocks.serviceRequest).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 409])(
    'log-and-swallows the permanent %i to "skipped" (non-retryable)',
    async (status) => {
      mocks.serviceRequest.mockRejectedValue(httpError(status));
      expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('skipped');
    },
  );

  it.each([500, 502, 503])('surfaces the transient %i as "failed" (retryable)', async (status) => {
    mocks.serviceRequest.mockRejectedValue(httpError(status));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it.each([408, 429])('treats the retryable 4xx %i as "failed", not permanent', async (status) => {
    mocks.serviceRequest.mockRejectedValue(httpError(status));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('treats a statusless network error as transient "failed"', async () => {
    mocks.serviceRequest.mockRejectedValue(new Error('socket hang up'));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('never throws — a permanent rejection resolves to a discriminant instead', async () => {
    mocks.serviceRequest.mockRejectedValue(httpError(409));
    await expect(reportFederatedActorGone('6981c9178fcdefaf81988ffb')).resolves.toBe('skipped');
  });
});
