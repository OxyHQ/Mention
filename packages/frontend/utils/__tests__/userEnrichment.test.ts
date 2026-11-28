import type { User as OxyUser } from '@oxy.so/core';
import { type Store, withStore } from '@oxy.so/bloom-data';
import { User } from '@oxy.so/services/ui/client';
import { openAccountStore, signOutForTests } from '@/test-support/accountScope';
import { enrichMissingAvatars, prewarmUsersByIds } from '../userEnrichment';

/** Both warm the account's `User` in one bulk read, and only the account that asked. */
jest.mock('@oxy.so/services/ui/client', () => ({
  ...require('@/test-support/oxyUsers').oxyUsers,
}));

const person = (id: string, avatar?: string) =>
  ({ id, username: id, avatar, name: { displayName: id } }) as OxyUser;

let store: Store;
const heldIds = (inStore: Store = store) => withStore(inStore, () => User.ids());

beforeEach(() => {
  store = openAccountStore();
});

afterEach(signOutForTests);

describe('enrichMissingAvatars', () => {
  it('asks once for the people without an absolute avatar and stores them', async () => {
    const getMany = jest.fn().mockResolvedValue([person('a', 'file-a'), person('', 'x')]);

    await enrichMissingAvatars(
      [{ id: 'a' }, { id: 'b', avatar: 'https://cdn/b.jpg' }, { id: '' }],
      getMany,
    );

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany).toHaveBeenCalledWith(['a']);
    expect(heldIds()).toEqual(['a']);
  });

  it('reads nothing when everybody has one', async () => {
    const getMany = jest.fn();
    await enrichMissingAvatars([{ id: 'b', avatar: 'https://cdn/b.jpg' }], getMany);
    expect(getMany).not.toHaveBeenCalled();
  });

  it('leaves the placeholders when the read fails', async () => {
    await expect(
      enrichMissingAvatars([{ id: 'a' }], jest.fn().mockRejectedValue(new Error('offline'))),
    ).resolves.toBeUndefined();
    expect(heldIds()).toEqual([]);
  });
});

describe('prewarmUsersByIds', () => {
  it('asks only for the people not held, once each', async () => {
    withStore(store, () => User.put({ id: 'held', username: 'held' }));
    const getMany = jest.fn().mockResolvedValue([person('a')]);

    await expect(prewarmUsersByIds(['held', 'a', 'a', ''], getMany)).resolves.toHaveLength(1);

    expect(getMany).toHaveBeenCalledWith(['a']);
    expect(heldIds()).toEqual(['held', 'a']);
    await expect(prewarmUsersByIds(['held', 'a'], getMany)).resolves.toEqual([]);
    expect(getMany).toHaveBeenCalledTimes(1);
  });

  it("stores nothing for an answer that lands after the account's store is left", async () => {
    let answer: (users: OxyUser[]) => void = () => undefined;
    const pending = prewarmUsersByIds(
      ['a'],
      () =>
        new Promise<OxyUser[]>((resolve) => {
          answer = resolve;
        }),
    );
    void store.close();
    const next = openAccountStore();

    answer([person('a')]);
    await pending;

    expect(heldIds(next)).toEqual([]);
  });

  it('resolves empty when the read fails', async () => {
    await expect(
      prewarmUsersByIds(['a'], jest.fn().mockRejectedValue(new Error('offline'))),
    ).resolves.toEqual([]);
  });
});
