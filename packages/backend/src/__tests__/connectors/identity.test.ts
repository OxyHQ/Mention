import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';

/** Oxy supplies canonical identity; Mention imports source content and renders that exact profile. */

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  persistRemoteMedia: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    makeServiceRequest: mocks.makeServiceRequest,
  }),
}));

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

import {
  deleteFederatedActorIdentity,
  reportFederatedActorGone,
  resolveOxyExternalUser,
} from '../../connectors/identity';
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
  mocks.makeServiceRequest.mockResolvedValue({ _id: 'oxy-resolved' });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false, reason: 'disabled' });
});

afterEach(async () => {
  await getDb().delete(userSettings).where(inArray(userSettings.oxyUserId, settingsOwners));
});

afterAll(async () => {
  await closePostgres();
});

describe('resolveOxyExternalUser', () => {
  it.each(['activitypub', 'atproto'] as const)('asks Oxy to verify %s transport without app identity claims', async (protocol) => {
    const actorUri = protocol === 'atproto' ? 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' : 'https://bird.makeup/users/alice';
    const transportAcct = protocol === 'atproto' ? 'alice.bsky.social' : 'alice@bird.makeup';
    mocks.makeServiceRequest.mockResolvedValue(oxyIdentityFixture({
      actorUri, transportAcct, protocol, canonicalAcct: 'alice@x.com', network: 'x.com',
    }));
    expect(await resolveOxyExternalUser({
      network: protocol, externalId: actorUri, handle: transportAcct,
      federatedUsername: 'untrusted@app.test', instanceDomain: 'app.test', bio: 'raw transport bio',
    })).toBe('oxy-resolved');
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', {
      actorUri, transportAcct, protocol,
    });
    expect(mocks.persistRemoteMedia).not.toHaveBeenCalled();
  });

  it('returns null when Oxy returns no authoritative identity', async () => {
    mocks.makeServiceRequest.mockResolvedValue({ id: 'legacy-only-id' });
    expect(await resolveOxyExternalUser({
      network: 'activitypub', externalId: 'https://bird.makeup/users/alice',
      handle: 'alice@bird.makeup', federatedUsername: 'alice@x.com', instanceDomain: 'x.com',
    })).toBeNull();
  });
});

describe('reportFederatedActorGone', () => {
  it('posts to /federation/actor-gone with the oxyUserId and returns "archived"', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      accountStatus: 'archived',
      alreadyArchived: false,
    });

    const outcome = await reportFederatedActorGone('6981c9178fcdefaf81988ffb');

    expect(outcome).toBe('archived');
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/actor-gone', {
      oxyUserId: '6981c9178fcdefaf81988ffb',
    });
  });

  it('returns "already" when Oxy reports the identity was already archived (idempotent 200)', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      accountStatus: 'archived',
      alreadyArchived: true,
    });

    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('already');
  });

  it('returns "skipped" without any network call for an empty id', async () => {
    expect(await reportFederatedActorGone('   ')).toBe('skipped');
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 409])(
    'log-and-swallows the permanent %i to "skipped" (non-retryable)',
    async (status) => {
      mocks.makeServiceRequest.mockRejectedValue(httpError(status));
      expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('skipped');
    },
  );

  it.each([500, 502, 503])('surfaces the transient %i as "failed" (retryable)', async (status) => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(status));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it.each([408, 429])('treats the retryable 4xx %i as "failed", not permanent', async (status) => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(status));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('treats a statusless network error as transient "failed"', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('socket hang up'));
    expect(await reportFederatedActorGone('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('never throws — a permanent rejection resolves to a discriminant instead', async () => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(409));
    await expect(reportFederatedActorGone('6981c9178fcdefaf81988ffb')).resolves.toBe('skipped');
  });
});

describe('deleteFederatedActorIdentity', () => {
  it('posts to /federation/actor-delete and returns "deleted" when Oxy removed a live identity', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      deleted: true,
      followEdgesRemoved: 3,
    });

    const outcome = await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb');

    expect(outcome).toBe('deleted');
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/actor-delete', {
      oxyUserId: '6981c9178fcdefaf81988ffb',
    });
  });

  it('returns "absent" on the idempotent no-op (200 with deleted:false — Oxy side already clean)', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      oxyUserId: '6981c9178fcdefaf81988ffb',
      deleted: false,
      followEdgesRemoved: 0,
    });

    expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('absent');
  });

  it('returns "skipped" without any network call for an empty id', async () => {
    expect(await deleteFederatedActorIdentity('   ')).toBe('skipped');
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it.each([400, 403, 409])(
    'log-and-swallows the permanent %i to "skipped" (non-retryable — keep the anchor)',
    async (status) => {
      mocks.makeServiceRequest.mockRejectedValue(httpError(status));
      expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('skipped');
    },
  );

  it.each([500, 502, 503])('surfaces the transient %i as "failed" (retryable — keep the anchor)', async (status) => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(status));
    expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it.each([408, 429])('treats the retryable 4xx %i as "failed", not permanent', async (status) => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(status));
    expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('treats a statusless network error as transient "failed"', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('socket hang up'));
    expect(await deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).toBe('failed');
  });

  it('never throws — a permanent rejection resolves to a discriminant instead', async () => {
    mocks.makeServiceRequest.mockRejectedValue(httpError(409));
    await expect(deleteFederatedActorIdentity('6981c9178fcdefaf81988ffb')).resolves.toBe('skipped');
  });
});
