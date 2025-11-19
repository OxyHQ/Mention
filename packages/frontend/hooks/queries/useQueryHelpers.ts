/**
 * React Query Helper Hooks
 * 
 * Provides reusable patterns and utilities for React Query hooks
 * following best practices from major tech companies
 */

import { useQueryClient, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ApiError } from '@/utils/api';

// ============================================================================
// Types
// ============================================================================

export interface QueryOptions<TData, TError = ApiError> 
  extends Omit<UseQueryOptions<TData, TError>, 'queryKey' | 'queryFn'> {
  enabled?: boolean;
}

export interface MutationOptions<TData, TVariables, TError = ApiError>
  extends Omit<UseMutationOptions<TData, TError, TVariables>, 'mutationFn'> {}

// ============================================================================
// Query Key Factory
// ============================================================================

/**
 * Creates a query key factory pattern for consistent key management
 * Example: queryKeys.posts.all, queryKeys.posts.detail(id)
 */
export function createQueryKeyFactory<T extends Record<string, (...args: any[]) => unknown[]>>(
  factory: T
): T & {
  all: unknown[][];
} {
  return {
    ...factory,
    all: Object.values(factory).map((fn) => fn()),
  } as T & { all: unknown[][] };
}

// ============================================================================
// Query Invalidation Helpers
// ============================================================================

/**
 * Hook for invalidating queries with type safety
 */
export function useInvalidateQueries() {
  const queryClient = useQueryClient();

  const invalidate = useCallback(
    (queryKey: unknown[]) => {
      return queryClient.invalidateQueries({ queryKey });
    },
    [queryClient]
  );

  const invalidateAll = useCallback(
    (predicate?: (query: { queryKey: unknown[] }) => boolean) => {
      return queryClient.invalidateQueries({ predicate });
    },
    [queryClient]
  );

  const removeQueries = useCallback(
    (queryKey: unknown[]) => {
      return queryClient.removeQueries({ queryKey });
    },
    [queryClient]
  );

  return {
    invalidate,
    invalidateAll,
    removeQueries,
  };
}

// ============================================================================
// Error Handling Helpers
// ============================================================================

/**
 * Extracts error message from ApiError or unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred';
}

/**
 * Checks if error is a network error
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === undefined || error.status === 0;
  }
  return false;
}

/**
 * Checks if error is an authentication error
 */
export function isAuthError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 401 || error.status === 403;
  }
  return false;
}

