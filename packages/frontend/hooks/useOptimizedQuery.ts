/**
 * Optimized Query Hooks
 * Enhanced React Query hooks with request deduplication and better caching
 */

import { useQuery, useMutation, useQueryClient, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';

/**
 * Optimized useQuery hook with automatic request deduplication
 * React Query already deduplicates by default, but this provides additional optimizations
 */
export function useOptimizedQuery<TData = unknown, TError = Error>(
  options: UseQueryOptions<TData, TError>
) {
  // React Query automatically deduplicates queries with the same key
  // We just need to ensure proper cache keys and stale times
  
  return useQuery<TData, TError>({
    ...options,
    // Ensure structural sharing is enabled (default, but explicit)
    structuralSharing: options.structuralSharing !== false,
    // Default stale time if not specified
    staleTime: options.staleTime ?? 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Optimized mutation hook with better error handling
 */
export function useOptimizedMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>
) {
  return useMutation<TData, TError, TVariables, TContext>({
    ...options,
    // Automatic retry for mutations
    retry: options.retry ?? 1,
  });
}

/**
 * Query key factory for consistent cache keys
 * Helps with cache invalidation and query management
 */
export const queryKeys = {
  // User queries
  user: (username?: string) => ['user', username] as const,
  userProfile: (username?: string) => ['user', 'profile', username] as const,
  
  // Post queries
  post: (postId: string) => ['post', postId] as const,
  posts: (filters?: Record<string, any>) => ['posts', filters] as const,
  
  // Feed queries
  feed: (type: string, filters?: Record<string, any>) => ['feed', type, filters] as const,
  
  // List queries
  lists: () => ['lists'] as const,
  list: (listId: string) => ['list', listId] as const,
  
  // Notification queries
  notifications: (filters?: Record<string, any>) => ['notifications', filters] as const,
  
  // Statistics queries
  statistics: (userId?: string, period?: number) => ['statistics', userId, period] as const,
  
  // Search queries
  search: (query: string, type?: string) => ['search', query, type] as const,
} as const;

/**
 * Helper to invalidate related queries
 * Useful for optimistic updates and cache management
 */
export function useQueryInvalidation() {
  const queryClient = useQueryClient();
  
  return {
    invalidateUser: (username?: string) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.user(username) });
      queryClient.invalidateQueries({ queryKey: queryKeys.userProfile(username) });
    },
    invalidatePost: (postId: string) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.post(postId) });
    },
    invalidateFeed: (type?: string) => {
      if (type) {
        queryClient.invalidateQueries({ queryKey: queryKeys.feed(type) });
      } else {
        queryClient.invalidateQueries({ queryKey: ['feed'] });
      }
    },
    invalidateAll: () => {
      queryClient.invalidateQueries();
    },
  };
}

