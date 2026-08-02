/**
 * Provider-related constants
 * Optimized for performance and better caching
 * Big tech best practices for React Query configuration
 */

interface RetriableError {
  status?: number;
}

export const QUERY_CLIENT_CONFIG = {
  defaultOptions: {
    queries: {
      // Retry strategy - exponential backoff
      retry: (failureCount: number, error: unknown) => {
        // Don't retry on 4xx errors (client errors)
        const status = (error as RetriableError | null)?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
          return false;
        }
        // Retry up to 2 times for network/server errors
        return failureCount < 2;
      },
      retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000),
      
      // Cache configuration - aggressive caching for better performance
      staleTime: 1000 * 60 * 5, // 5 minutes - data stays fresh
      gcTime: 1000 * 60 * 30, // 30 minutes - cache persists for 30 min
      
      // Refetch strategy - minimize unnecessary network requests
      refetchOnReconnect: true, // Refetch when connection restored
      refetchOnWindowFocus: false, // Disabled - prevents annoying refetches

      // `refetchOnMount` is deliberately left at the library default (refetch on
      // mount ONLY when the data is stale). `staleTime` above — and the shorter
      // one every screen declares for itself — is the lever that keeps a cached
      // screen instant: fresh data is still painted from cache with no request.
      //
      // Pinning it to `false` instead would silently disarm `invalidateQueries`
      // for every query that is not mounted at the moment of the write, which is
      // the normal case: a post is saved from the feed, and the saved screen —
      // where the change has to show up — is a navigation away. Invalidation
      // marks such a query stale and leaves the refetch to its next mount, so a
      // client that never refetches on mount serves the pre-write list until the
      // 30-minute `gcTime` expires or the page is reloaded.

      // Enable structural sharing for better performance
      // Compares data structures to minimize re-renders
      structuralSharing: true,
      
      // Network mode - handle offline gracefully
      networkMode: 'online', // Only refetch when online
    },
    mutations: {
      // A lost response does not prove a write failed. Retrying a POST can
      // duplicate reviews, analytics and other non-idempotent actions.
      retry: false,
      
      // Optimistic updates enabled by default (implement per mutation)
      // This provides instant UI feedback
    },
  },
  
  // Query cache configuration
  queryCache: undefined, // Use default cache
  
  // Mutation cache configuration  
  mutationCache: undefined, // Use default cache
} as const;
