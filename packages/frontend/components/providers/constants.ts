/**
 * Provider-related constants
 * Optimized for performance and better caching
 */

export const QUERY_CLIENT_CONFIG = {
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 1000 * 60 * 5, // 5 minutes - increased for better performance
      gcTime: 1000 * 60 * 30, // 30 minutes - increased cache time
      refetchOnReconnect: true,
      refetchOnWindowFocus: false, // Disabled to prevent unnecessary refetches
      refetchOnMount: false, // Use cached data when available
      // Enable structural sharing for better performance
      structuralSharing: true,
    },
    mutations: {
      retry: 1, // Retry mutations once on failure
    },
  },
} as const;

