/**
 * `fetchProfileConnections` — one page of a profile's followers or following,
 * the Oxy graph then the mirrored edges. The id is path-encoded and the next
 * page is asked for by cursor.
 */

import { authenticatedClient } from '@/utils/api';
import { fetchProfileConnections } from '../profileConnectionsService';

jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: jest.fn() },
}));

const mockGet = jest.mocked(authenticatedClient.get);

describe('fetchProfileConnections', () => {
  it('reads the encoded profile path, with the cursor only when paging', async () => {
    mockGet.mockResolvedValue({ data: { users: [], hasMore: false } });

    await fetchProfileConnections('a/b', 'following');
    await fetchProfileConnections('a/b', 'followers', 'mirror:x');

    expect(mockGet.mock.calls).toEqual([
      ['/profile/connections/a%2Fb/following', undefined],
      ['/profile/connections/a%2Fb/followers', { params: { cursor: 'mirror:x' } }],
    ]);
  });
});
