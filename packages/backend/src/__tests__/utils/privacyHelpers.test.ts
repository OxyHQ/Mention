import { beforeEach, describe, expect, it, vi } from 'vitest';

// `privacyHelpers` resolves the following-list fallback through
// `getServiceOxyClient()` (the service-authed client), not the bare server `oxy`
// singleton. Stub it so the module loads in isolation; the tests below always
// pass an explicit viewer-scoped client, so the fallback is never exercised.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserFollowing: vi.fn().mockResolvedValue([]),
    getUserFollowers: vi.fn().mockResolvedValue([]),
    getBlockedUsers: vi.fn().mockResolvedValue([]),
    getRestrictedUsers: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '../../utils/logger';
import {
  getBlockedUserIds,
  getRestrictedUserIds,
  type OxyClient,
} from '../../utils/privacyHelpers';

function makeClient(overrides: Partial<OxyClient>): OxyClient {
  return {
    getBlockedUsers: vi.fn().mockResolvedValue([]),
    getRestrictedUsers: vi.fn().mockResolvedValue([]),
    getUserFollowing: vi.fn().mockResolvedValue([]),
    getUserFollowers: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('privacyHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed when Oxy rejects the blocked-list auth context', async () => {
    const error = Object.assign(new Error('Invalid or missing authorization header'), {
      code: 'UNAUTHORIZED',
      status: 401,
    });
    const client = makeClient({
      getBlockedUsers: vi.fn().mockRejectedValue(error),
    });

    await expect(getBlockedUserIds(client)).rejects.toMatchObject({
      name: 'OxyPrivacyAuthorizationError',
      listType: 'blocked',
      status: 401,
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('blocked privacy authorization failed'),
      expect.objectContaining({ status: 401, code: 'UNAUTHORIZED' }),
    );
  });

  it('fails closed when Oxy rejects the restricted-list auth context', async () => {
    const error = Object.assign(new Error('Forbidden'), {
      code: 'FORBIDDEN',
      status: 403,
    });
    const client = makeClient({
      getRestrictedUsers: vi.fn().mockRejectedValue(error),
    });

    await expect(getRestrictedUserIds(client)).rejects.toMatchObject({
      name: 'OxyPrivacyAuthorizationError',
      listType: 'restricted',
      status: 403,
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('restricted privacy authorization failed'),
      expect.objectContaining({ status: 403, code: 'FORBIDDEN' }),
    );
  });

  it('fails closed when the blocked-list request has a transient network error', async () => {
    const error = Object.assign(new Error('network unavailable'), {
      code: 'NETWORK_ERROR',
    });
    const client = makeClient({
      getBlockedUsers: vi.fn().mockRejectedValue(error),
    });

    await expect(getBlockedUserIds(client)).rejects.toMatchObject({
      name: 'OxyPrivacyUnavailableError',
      listType: 'blocked',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('blocked privacy resolution failed'),
      expect.objectContaining({ code: 'NETWORK_ERROR', network: true }),
    );
  });

  it('fails closed when the restricted-list response cannot be resolved', async () => {
    const client = makeClient({
      getRestrictedUsers: vi.fn().mockRejectedValue(new Error('malformed response')),
    });

    await expect(getRestrictedUserIds(client)).rejects.toMatchObject({
      name: 'OxyPrivacyUnavailableError',
      listType: 'restricted',
    });
  });

  it('fails closed when an authenticated path has no scoped Oxy client', async () => {
    await expect(getBlockedUserIds()).rejects.toMatchObject({
      name: 'OxyPrivacyUnavailableError',
      listType: 'blocked',
      code: 'MISSING_PRIVACY_CLIENT',
    });
    await expect(getRestrictedUserIds()).rejects.toMatchObject({
      name: 'OxyPrivacyUnavailableError',
      listType: 'restricted',
      code: 'MISSING_PRIVACY_CLIENT',
    });
  });
});
