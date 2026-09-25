import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

import { invalidateProfileCounts as invalidate } from '../profileCountsInvalidation';

const mockInvalidateQueries = jest.fn();
const client = { invalidateQueries: mockInvalidateQueries } as never;
const invalidateProfileCounts = (authorId?: string) => invalidate(client, authorId);

type Predicate = (query: { queryKey: readonly unknown[] }) => boolean;

function capturedPredicate(): Predicate {
  const options = mockInvalidateQueries.mock.calls.at(-1)?.[0] as { predicate?: Predicate } | undefined;
  if (typeof options?.predicate !== 'function') throw new Error('no predicate passed to invalidateQueries');
  return options.predicate;
}

/**
 * The profile read "0 Posts" above the post it had just listed (#1140): the
 * counters ride the appearance payload, cached behind a five-minute staleTime,
 * and nothing dropped it when a post was published. Run the predicate against
 * the key `useProfileData` actually builds; a call count would pass just as
 * happily on a predicate that matched nothing.
 */
describe('invalidateProfileCounts', () => {
  beforeEach(() => mockInvalidateQueries.mockClear());

  it("drops the viewer's own counters and nobody else's", () => {
    invalidateProfileCounts();
    const predicate = capturedPredicate();

    expect(predicate({ queryKey: viewerQueryKeys.appearanceForUser('viewer-a', 'viewer-a') })).toBe(true);
    expect(predicate({ queryKey: viewerQueryKeys.appearanceForUser('viewer-a', 'someone') })).toBe(false);
    expect(predicate({ queryKey: viewerQueryKeys.appearanceForUser(null, 'anon') })).toBe(false);
    expect(predicate({ queryKey: viewerQueryKeys.notifications('viewer-a') })).toBe(false);
  });

  it('also drops every copy of the account the write was published as', () => {
    invalidateProfileCounts('channel-1');
    const predicate = capturedPredicate();

    expect(predicate({ queryKey: viewerQueryKeys.appearanceForUser('viewer-a', 'channel-1') })).toBe(true);
    expect(predicate({ queryKey: viewerQueryKeys.appearanceForUser('other-viewer', 'channel-1') })).toBe(true);
    expect(predicate({ queryKey: viewerQueryKeys.appearanceForUser('viewer-a', 'viewer-a') })).toBe(true);
    expect(predicate({ queryKey: viewerQueryKeys.appearanceForUser('viewer-a', 'someone') })).toBe(false);
  });
});
