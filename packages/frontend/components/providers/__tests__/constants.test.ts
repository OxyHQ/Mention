import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

describe('QueryClient mutation defaults', () => {
  it('does not retry writes without an explicit idempotent opt-in', () => {
    expect(QUERY_CLIENT_CONFIG.defaultOptions.mutations.retry).toBe(false);
  });
});
