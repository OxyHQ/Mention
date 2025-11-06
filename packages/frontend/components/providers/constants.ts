/**
 * Provider-related constants
 */

export const QUERY_CLIENT_CONFIG = {
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 1000 * 30,
      gcTime: 1000 * 60 * 10,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    },
  },
} as const;

