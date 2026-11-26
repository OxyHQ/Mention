import TestRenderer, { act } from 'react-test-renderer';
import { DataProvider, Store, withStore } from '@oxy.so/bloom-data';
import { User as UserRecord, useUserById as mockUseSdkUserById } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';
import { useCachedUserSnapshot } from '@/hooks/useCachedUser';

// The real `User` entity; the SDK's fetching read is a spy that must stay idle.
jest.mock('@oxy.so/services/ui/client', () => ({
  ...require('@/test-support/oxyUsers').oxyUsers,
  useUserById: jest.fn(),
}));

const seen: (User | undefined)[] = [];
function Probe({ id }: { id: string }) {
  seen.push(useCachedUserSnapshot(id));
  return null;
}

describe('useCachedUserSnapshot', () => {
  beforeEach(() => {
    seen.length = 0;
    (mockUseSdkUserById as jest.Mock).mockClear();
  });

  it('reads a held record without ever fetching, and follows later writes', () => {
    const store = new Store();
    withStore(store, () => UserRecord.put({ id: 'u1', username: 'ada' } as never));

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <DataProvider store={store}>
          <Probe id="u1" />
        </DataProvider>,
      );
    });
    expect(seen.at(-1)).toMatchObject({ id: 'u1', username: 'ada' });

    // A batched avatar enrichment lands on the same record.
    act(() => {
      withStore(store, () => UserRecord.merge('u1', { avatar: 'file-1' } as never));
    });
    expect(seen.at(-1)).toMatchObject({ id: 'u1', username: 'ada', avatar: 'file-1' });

    expect(mockUseSdkUserById).not.toHaveBeenCalled();
    act(() => renderer?.unmount());
  });

  it('is undefined for an id nothing has stored, still without a request', () => {
    const store = new Store();
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <DataProvider store={store}>
          <Probe id="nobody" />
        </DataProvider>,
      );
    });
    expect(seen.at(-1)).toBeUndefined();
    expect(mockUseSdkUserById).not.toHaveBeenCalled();
    expect(withStore(store, () => UserRecord.ids())).toEqual([]);
    act(() => renderer?.unmount());
  });
});
