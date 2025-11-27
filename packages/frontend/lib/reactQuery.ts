import { QueryClient } from '@tanstack/react-query';

/**
 * React Query client configuration
 * This centralized configuration allows for consistent query behavior throughout the app
 */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data considered fresh for 10 minutes (increased for better performance)
      staleTime: 1000 * 60 * 10,
      
      // Keep unused data in cache for 30 minutes before garbage collection (increased)
      gcTime: 1000 * 60 * 30,
      
      // Only retry failed requests once
      retry: 1,
      
      // Disable automatic refetching when window gets focus (better for mobile apps)
      refetchOnWindowFocus: false,
      
      // Disable refetching on reconnect (handled by socket connections when needed)
      refetchOnReconnect: false,
      
      // Enable structural sharing for better memory efficiency
      structuralSharing: true,
    },
    mutations: {
      // Enable optimistic updates for better UX
      retry: 1,
    },
  },
});

/**
 * Custom hook to invalidate all queries matching a specific key pattern
 * Useful for refreshing multiple related queries at once
 */
export function invalidateRelatedQueries(queryClient: QueryClient, keyPattern: unknown[]) {
  // Remove the first element (base type), keep other filtering criteria
  const filterKey = keyPattern.slice(1);
  
  // Find and invalidate all queries that match the pattern
  return queryClient.invalidateQueries({
    predicate: (query) => {
      // Skip if query key isn't an array or doesn't have a base type match
      if (!Array.isArray(query.queryKey) || query.queryKey[0] !== keyPattern[0]) {
        return false;
      }

      // Match if no additional filters, or if all filter criteria are satisfied
      return filterKey.length === 0 || 
        filterKey.every((key, index) => 
          key === undefined || key === query.queryKey[index + 1]
        );
    },
  });
}