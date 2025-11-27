/**
 * Provider-related constants
 * Optimized for performance and better caching
 * Big tech best practices for React Query configuration
 */

export const QUERY_CLIENT_CONFIG = {
  defaultOptions: {
    queries: {
      // Retry strategy - exponential backoff
      retry: (failureCount, error: any) => {
        // Don't retry on 4xx errors (client errors)
        if (error?.status >= 400 && error?.status < 500) {
          return false;
        }
        // Retry up to 2 times for network/server errors
        return failureCount < 2;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      
      // Cache configuration - aggressive caching for better performance
      staleTime: 1000 * 60 * 5, // 5 minutes - data stays fresh
      gcTime: 1000 * 60 * 30, // 30 minutes - cache persists for 30 min
      
      // Refetch strategy - minimize unnecessary network requests
      refetchOnReconnect: true, // Refetch when connection restored
      refetchOnWindowFocus: false, // Disabled - prevents annoying refetches
      refetchOnMount: false, // Use cached data when available - faster UX
      
      // Enable structural sharing for better performance
      // Compares data structures to minimize re-renders
      structuralSharing: true,
      
      // Network mode - handle offline gracefully
      networkMode: 'online', // Only refetch when online
    },
    mutations: {
      // Mutation retry - only once for failed mutations
      retry: 1,
      retryDelay: 1000,
      
      // Optimistic updates enabled by default (implement per mutation)
      // This provides instant UI feedback
    },
  },
  
  // Query cache configuration
  queryCache: undefined, // Use default cache
  
  // Mutation cache configuration  
  mutationCache: undefined, // Use default cache
} as const;

