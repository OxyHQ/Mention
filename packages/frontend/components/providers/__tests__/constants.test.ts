import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

describe('QueryClient mutation defaults', () => {
  it('does not retry writes without an explicit idempotent opt-in', () => {
    expect(QUERY_CLIENT_CONFIG.defaultOptions.mutations.retry).toBe(false);
  });
});

describe('QueryClient query defaults', () => {
  // Pinning `refetchOnMount` client-wide disarms `invalidateQueries` for every
  // query that is not mounted at the moment of the write — the normal case, and
  // the reason a saved post used to need a page reload to appear. Freshness is
  // `staleTime`'s job; leaving this unset keeps both behaviours.
  it('leaves refetch-on-mount to each query\'s own staleTime', () => {
    expect(QUERY_CLIENT_CONFIG.defaultOptions.queries).not.toHaveProperty(
      'refetchOnMount',
    );
  });
});
