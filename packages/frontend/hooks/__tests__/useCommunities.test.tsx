import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useCommunityModerators, useJoinedCommunities } from '../useCommunities';

/**
 * The two community reads: the joined communities only with a session that can
 * make a private call, and a community's moderators from Oxy's public list,
 * asked only once there is a community to ask about.
 */

const mockAuth = {
  user: { id: 'viewer-1' } as { id: string } | null,
  canUsePrivateApi: true,
  oxyServices: { users: { moderators: jest.fn(async () => [{ id: 'mod-1' }]) } },
};
const mockJoined = jest.fn(async () => [{ id: 'forum-1' }]);

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@/services/communityService', () => ({
  communityService: { joined: () => mockJoined() },
}));

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

function render(probe: () => unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result: { current: unknown } = { current: null };
  function Probe() {
    result.current = probe();
    return null;
  }
  act(() => {
    TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return result;
}

describe('community reads', () => {
  it('asks for joined communities with a session, and moderators for a community', async () => {
    const joined = render(() => useJoinedCommunities());
    const moderators = render(() => useCommunityModerators('forum-1'));
    const none = render(() => useCommunityModerators(null));
    await flush();
    expect((joined.current as { data?: unknown }).data).toEqual([{ id: 'forum-1' }]);
    expect((moderators.current as { data?: unknown }).data).toEqual([{ id: 'mod-1' }]);
    expect(mockAuth.oxyServices.users.moderators).toHaveBeenCalledTimes(1);
    expect((none.current as { fetchStatus?: string }).fetchStatus).toBe('idle');

    mockAuth.canUsePrivateApi = false;
    mockJoined.mockClear();
    render(() => useJoinedCommunities());
    await flush();
    expect(mockJoined).not.toHaveBeenCalled();
  });
});
