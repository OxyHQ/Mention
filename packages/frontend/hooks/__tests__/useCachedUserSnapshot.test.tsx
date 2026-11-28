import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@oxy.so/core';
import { useCachedUserSnapshot } from '@/hooks/useCachedUser';

jest.mock('@oxy.so/services/ui/client', () => ({
  queryKeys: { users: { detail: (id: string) => ['users', 'detail', id] } },
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
  });

  it('reads a stale seeded entry without ever fetching, and follows later writes', async () => {
    const client = new QueryClient();
    const fetchSpy = jest.spyOn(client, 'fetchQuery');
    // The actor cache seeds cold entries STALE (updatedAt 0) on purpose.
    client.setQueryData(['users', 'detail', 'u1'], { id: 'u1', username: 'ada' }, { updatedAt: 0 });

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <Probe id="u1" />
        </QueryClientProvider>,
      );
    });
    expect(seen.at(-1)).toEqual({ id: 'u1', username: 'ada' });

    await act(async () => {
      client.setQueryData(['users', 'detail', 'u1'], {
        id: 'u1',
        username: 'ada',
        avatar: 'file-1',
      });
      // React Query delivers observer notifications on its next tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen.at(-1)).toEqual({ id: 'u1', username: 'ada', avatar: 'file-1' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.getQueryState(['users', 'detail', 'u1'])?.fetchStatus).toBe('idle');
    act(() => renderer?.unmount());
  });

  it('is undefined for an id nothing has cached, still without a request', () => {
    const client = new QueryClient();
    act(() => {
      TestRenderer.create(
        <QueryClientProvider client={client}>
          <Probe id="nobody" />
        </QueryClientProvider>,
      );
    });
    expect(seen.at(-1)).toBeUndefined();
    expect(client.getQueryState(['users', 'detail', 'nobody'])?.fetchStatus ?? 'idle').toBe('idle');
  });
});
