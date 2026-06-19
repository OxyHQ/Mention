import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../server', () => ({
  oxy: {},
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

  it('treats missing Oxy auth context as an empty blocked list without error logging', async () => {
    const error = Object.assign(new Error('Invalid or missing authorization header'), {
      code: 'UNAUTHORIZED',
      status: 401,
    });
    const client = makeClient({
      getBlockedUsers: vi.fn().mockRejectedValue(error),
    });

    await expect(getBlockedUserIds(client)).resolves.toEqual([]);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Skipping blocked users'),
      expect.objectContaining({ status: 401, code: 'UNAUTHORIZED' }),
    );
  });

  it('treats forbidden Oxy auth context as an empty restricted list without error logging', async () => {
    const error = Object.assign(new Error('Forbidden'), {
      code: 'FORBIDDEN',
      status: 403,
    });
    const client = makeClient({
      getRestrictedUsers: vi.fn().mockRejectedValue(error),
    });

    await expect(getRestrictedUserIds(client)).resolves.toEqual([]);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Skipping restricted users'),
      expect.objectContaining({ status: 403, code: 'FORBIDDEN' }),
    );
  });
});
