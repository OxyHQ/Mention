import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  muteFind: vi.fn(),
  getBlockedUserIds: vi.fn(),
  getRestrictedUserIds: vi.fn(),
}));

vi.mock('../../models/Mute', () => ({
  default: { find: mocks.muteFind },
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: mocks.getBlockedUserIds,
  getRestrictedUserIds: mocks.getRestrictedUserIds,
}));

import { UserPrivacyManager } from '../../mtn/UserPrivacyManager';

function muteQuery(rows: Array<{ mutedId?: string }>) {
  return {
    lean: vi.fn().mockResolvedValue(rows),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.muteFind.mockReturnValue(muteQuery([]));
  mocks.getBlockedUserIds.mockResolvedValue([]);
  mocks.getRestrictedUserIds.mockResolvedValue([]);
});

describe('UserPrivacyManager Oxy authority', () => {
  it('combines Oxy blocks/restrictions with Mention-local mutes and deduplicates', async () => {
    const scopedOxyClient = { request: 'client' };
    mocks.getBlockedUserIds.mockResolvedValue(['blocked', 'duplicate']);
    mocks.getRestrictedUserIds.mockResolvedValue(['restricted', 'duplicate']);
    mocks.muteFind.mockReturnValue(muteQuery([
      { mutedId: 'muted' },
      { mutedId: 'duplicate' },
      { mutedId: '' },
    ]));

    const state = await UserPrivacyManager.loadPrivacyState('viewer', {
      oxyClient: scopedOxyClient as never,
      includeRestricted: true,
    });

    expect(state.blockedUserIds).toEqual(new Set(['blocked', 'duplicate']));
    expect(state.mutedUserIds).toEqual(new Set(['muted', 'duplicate']));
    expect(state.restrictedUserIds).toEqual(new Set(['restricted', 'duplicate']));
    expect(state.excludedUserIds).toEqual(
      new Set(['blocked', 'duplicate', 'muted', 'restricted']),
    );
    expect(mocks.getBlockedUserIds).toHaveBeenCalledWith(scopedOxyClient);
    expect(mocks.getRestrictedUserIds).toHaveBeenCalledWith(scopedOxyClient);
    expect(mocks.muteFind).toHaveBeenCalledWith(
      { userId: 'viewer' },
      { mutedId: 1, _id: 0 },
    );
  });

  it('does not fetch restrictions for feed callers', async () => {
    const scopedOxyClient = { request: 'client' };
    mocks.getBlockedUserIds.mockResolvedValue(['blocked']);
    mocks.muteFind.mockReturnValue(muteQuery([{ mutedId: 'muted' }]));

    const state = await UserPrivacyManager.loadPrivacyState('viewer', {
      oxyClient: scopedOxyClient as never,
    });

    expect(state.excludedUserIds).toEqual(new Set(['blocked', 'muted']));
    expect(mocks.getBlockedUserIds).toHaveBeenCalledWith(scopedOxyClient);
    expect(mocks.getRestrictedUserIds).not.toHaveBeenCalled();
  });

  it('preserves Oxy exclusions when the local mute read fails', async () => {
    mocks.getBlockedUserIds.mockResolvedValue(['blocked']);
    mocks.getRestrictedUserIds.mockResolvedValue(['restricted']);
    mocks.muteFind.mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('mongo down')),
    });

    const state = await UserPrivacyManager.loadPrivacyState('viewer', {
      oxyClient: {} as never,
      includeRestricted: true,
    });

    expect(state.blockedUserIds).toEqual(new Set(['blocked']));
    expect(state.mutedUserIds).toEqual(new Set());
    expect(state.restrictedUserIds).toEqual(new Set(['restricted']));
    expect(state.excludedUserIds).toEqual(new Set(['blocked', 'restricted']));
  });

  it('does not turn a rejected Oxy privacy context into an empty exclusion set', async () => {
    mocks.getBlockedUserIds.mockRejectedValue(
      new Error('delegated privacy authorization rejected'),
    );

    await expect(
      UserPrivacyManager.loadPrivacyState('viewer', {
        oxyClient: {} as never,
      }),
    ).rejects.toThrow('delegated privacy authorization rejected');
  });
});
