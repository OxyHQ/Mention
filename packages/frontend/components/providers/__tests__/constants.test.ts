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
  it("leaves refetch-on-mount to each query's own staleTime", () => {
    expect(QUERY_CLIENT_CONFIG.defaultOptions.queries).not.toHaveProperty('refetchOnMount');
  });
});

describe('QueryClient retry policy', () => {
  const { retry, retryDelay } = QUERY_CLIENT_CONFIG.defaultOptions.queries;

  it('never retries a client error, and retries anything else twice', () => {
    expect(retry(0, { status: 404 })).toBe(false);
    expect(retry(0, { status: 503 })).toBe(true);
    expect(retry(1, new Error('offline'))).toBe(true);
    expect(retry(2, null)).toBe(false);
  });

  it('backs off exponentially up to 30 s', () => {
    expect(retryDelay(0)).toBe(1000);
    expect(retryDelay(3)).toBe(8000);
    expect(retryDelay(10)).toBe(30000);
  });
});
