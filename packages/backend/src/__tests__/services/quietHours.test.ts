import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mention asks Oxy who is in their quiet hours (oxy ADR 0068). Under test: the
 * question is batched to Oxy's limit, and an Oxy that cannot answer holds no
 * push at all rather than every push.
 */

const oxyAccountsInQuietHours = vi.fn();
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ accountsInQuietHours: oxyAccountsInQuietHours }),
}));

import { accountsInQuietHours } from '../../services/scheduling/quietHours';

beforeEach(() => {
  oxyAccountsInQuietHours.mockReset();
});

describe('accountsInQuietHours', () => {
  it('returns what Oxy says, asking once about each account', async () => {
    oxyAccountsInQuietHours.mockResolvedValue(new Set(['b']));
    expect([...(await accountsInQuietHours(['a', 'b', 'b', 'c']))]).toEqual(['b']);
    expect(oxyAccountsInQuietHours).toHaveBeenCalledTimes(1);
    expect(oxyAccountsInQuietHours).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('asks in batches of a hundred and joins the answers', async () => {
    const ids = Array.from({ length: 230 }, (_, index) => `account_${index}`);
    oxyAccountsInQuietHours.mockImplementation(async (batch: string[]) => new Set([batch[0]]));

    const quiet = await accountsInQuietHours(ids);

    expect(oxyAccountsInQuietHours.mock.calls.map(([batch]) => batch.length)).toEqual([
      100, 100, 30,
    ]);
    expect([...quiet]).toEqual(['account_0', 'account_100', 'account_200']);
  });

  it('asks nothing for nobody', async () => {
    expect((await accountsInQuietHours([])).size).toBe(0);
    expect(oxyAccountsInQuietHours).not.toHaveBeenCalled();
  });

  it('holds no push when Oxy cannot answer, even after a first batch did', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `account_${index}`);
    oxyAccountsInQuietHours
      .mockResolvedValueOnce(new Set(['account_1']))
      .mockRejectedValueOnce(new Error('Oxy is unavailable'));
    expect((await accountsInQuietHours(ids)).size).toBe(0);
  });
});
