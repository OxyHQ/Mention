/**
 * Query Hooks & Cache Key Utilities for the Spaces app
 *
 * useOptimizedQuery / useOptimizedMutation are thin wrappers around React Query
 * that set sensible defaults (5-min staleTime, 1 retry for mutations).
 * The primary value of this module is the `spaceQueryKeys` factory and the
 * `useSpacesQueryInvalidation` helper which enforce consistent cache keys.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useAgoraConfig } from '@mention/agora-shared';
import type { Room, UserEntity } from '@mention/agora-shared';
import type { OxyServices } from '@oxyhq/core';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STALE_TIME = 1000 * 60 * 5; // 5 minutes

// ---------------------------------------------------------------------------
// Generic wrappers
// ---------------------------------------------------------------------------

/**
 * useQuery with sensible defaults (5-min staleTime, structural sharing on).
 */
export function useOptimizedQuery<TData = unknown, TError = Error>(
  options: Parameters<typeof useQuery<TData, TError>>[0],
) {
  return useQuery<TData, TError>({
    ...options,
    structuralSharing: options.structuralSharing !== false,
    staleTime: options.staleTime ?? DEFAULT_STALE_TIME,
  });
}

/**
 * useMutation with 1 automatic retry on failure.
 */
export function useOptimizedMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: Parameters<typeof useMutation<TData, TError, TVariables, TContext>>[0],
) {
  return useMutation<TData, TError, TVariables, TContext>({
    ...options,
    retry: options.retry ?? 1,
  });
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export const spaceQueryKeys = {
  all: ['spaces'] as const,
  lists: () => [...spaceQueryKeys.all, 'list'] as const,
  list: (status?: string) => [...spaceQueryKeys.lists(), status] as const,
  details: () => [...spaceQueryKeys.all, 'detail'] as const,
  detail: (id: string) => [...spaceQueryKeys.details(), id] as const,
  userSpaces: (userId: string) => [...spaceQueryKeys.all, 'user', userId] as const,
  followers: (userId: string) => ['followers', userId] as const,
  following: (userId: string) => ['following', userId] as const,
} as const;

// ---------------------------------------------------------------------------
// Invalidation helper
// ---------------------------------------------------------------------------

export function useSpacesQueryInvalidation() {
  const queryClient = useQueryClient();

  return {
    /** Invalidate all space list queries (any status filter). */
    invalidateSpaceLists: () => {
      queryClient.invalidateQueries({ queryKey: spaceQueryKeys.lists() });
    },

    /** Invalidate a single space detail query. */
    invalidateSpace: (id: string) => {
      queryClient.invalidateQueries({ queryKey: spaceQueryKeys.detail(id) });
    },

    /** Invalidate the spaces belonging to a specific user. */
    invalidateUserSpaces: (userId: string) => {
      queryClient.invalidateQueries({ queryKey: spaceQueryKeys.userSpaces(userId) });
    },

    /** Invalidate a user's followers list. */
    invalidateFollowers: (userId: string) => {
      queryClient.invalidateQueries({ queryKey: spaceQueryKeys.followers(userId) });
    },

    /** Invalidate a user's following list. */
    invalidateFollowing: (userId: string) => {
      queryClient.invalidateQueries({ queryKey: spaceQueryKeys.following(userId) });
    },

    /** Nuclear option -- invalidate every spaces-related query. */
    invalidateAll: () => {
      queryClient.invalidateQueries({ queryKey: spaceQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ['followers'] });
      queryClient.invalidateQueries({ queryKey: ['following'] });
    },
  };
}

// ---------------------------------------------------------------------------
// Domain hooks -- Spaces
// ---------------------------------------------------------------------------

/** Fetch a list of spaces, optionally filtered by status. */
export function useSpaces(status?: string) {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<Room[]>({
    queryKey: spaceQueryKeys.list(status),
    queryFn: () => agoraService.getRooms(status),
  });
}

/** Fetch a single space by id. Disabled when id is falsy. */
export function useSpace(id: string | undefined) {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<Room | null>({
    queryKey: spaceQueryKeys.detail(id!),
    queryFn: () => agoraService.getRoom(id!),
    enabled: !!id,
  });
}

interface UserSpacesResult {
  all: Room[];
  live: Room[];
  scheduled: Room[];
}

/**
 * Fetch all spaces where the given user is the host.
 * Fires three parallel requests (live, scheduled, ended) and filters by host.
 * Disabled when userId is falsy.
 */
export function useUserSpaces(userId: string | undefined) {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<UserSpacesResult>({
    queryKey: spaceQueryKeys.userSpaces(userId!),
    queryFn: async (): Promise<UserSpacesResult> => {
      const [live, scheduled, ended] = await Promise.all([
        agoraService.getRooms('live'),
        agoraService.getRooms('scheduled'),
        agoraService.getRooms('ended'),
      ]);

      const isHost = (s: Room) => s.host === userId;
      const all = [...live, ...scheduled, ...ended].filter(isHost);

      return {
        all,
        live: live.filter(isHost),
        scheduled: scheduled.filter(isHost),
      };
    },
    enabled: !!userId,
  });
}

// ---------------------------------------------------------------------------
// Domain hooks -- Followers / Following
// ---------------------------------------------------------------------------

/**
 * Fetch the followers list for a user.
 * The response may come back as `result.followers` (object wrapper) or a plain
 * array -- this hook normalises both shapes.
 */
export function useFollowersList(oxyServices: OxyServices | null | undefined, userId: string | undefined) {
  return useOptimizedQuery<UserEntity[]>({
    queryKey: spaceQueryKeys.followers(userId!),
    queryFn: async () => {
      const result = await oxyServices!.getUserFollowers(userId!);
      return result.followers ?? [];
    },
    enabled: !!userId && !!oxyServices,
  });
}

/**
 * Fetch the following list for a user.
 * Same response-shape normalisation as `useFollowersList`.
 */
export function useFollowingList(oxyServices: OxyServices | null | undefined, userId: string | undefined) {
  return useOptimizedQuery<UserEntity[]>({
    queryKey: spaceQueryKeys.following(userId!),
    queryFn: async () => {
      const result = await oxyServices!.getUserFollowing(userId!);
      return result.following ?? [];
    },
    enabled: !!userId && !!oxyServices,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

interface CreateSpaceInput {
  title: string;
  description?: string;
  topic?: string;
  scheduledStart?: string;
  speakerPermission?: 'everyone' | 'followers' | 'invited';
}

/** Create a new space. Invalidates space list queries on success. */
export function useCreateSpace() {
  const { agoraService } = useAgoraConfig();
  const { invalidateSpaceLists } = useSpacesQueryInvalidation();

  return useOptimizedMutation<Room | null, Error, CreateSpaceInput>({
    mutationFn: (data) => agoraService.createRoom(data),
    onSuccess: () => {
      invalidateSpaceLists();
    },
  });
}

/** Start a space. Invalidates both the individual space and list queries. */
export function useStartSpace() {
  const { agoraService } = useAgoraConfig();
  const { invalidateSpaceLists, invalidateSpace } = useSpacesQueryInvalidation();

  return useOptimizedMutation<boolean, Error, string>({
    mutationFn: (id) => agoraService.startRoom(id),
    onSuccess: (_data, id) => {
      invalidateSpace(id);
      invalidateSpaceLists();
    },
  });
}

/** End a space. Invalidates both the individual space and list queries. */
export function useEndSpace() {
  const { agoraService } = useAgoraConfig();
  const { invalidateSpaceLists, invalidateSpace } = useSpacesQueryInvalidation();

  return useOptimizedMutation<boolean, Error, string>({
    mutationFn: (id) => agoraService.endRoom(id),
    onSuccess: (_data, id) => {
      invalidateSpace(id);
      invalidateSpaceLists();
    },
  });
}

/** Delete a space. Invalidates space list and user-specific queries on success. */
export function useDeleteSpace() {
  const { agoraService } = useAgoraConfig();
  const { invalidateSpaceLists, invalidateUserSpaces } = useSpacesQueryInvalidation();

  return useOptimizedMutation<boolean, Error, { id: string; userId: string }>({
    mutationFn: ({ id }) => agoraService.deleteRoom(id),
    onSuccess: (_data, { userId }) => {
      invalidateSpaceLists();
      if (userId) invalidateUserSpaces(userId);
    },
  });
}

/** Archive/unarchive a space. Invalidates the space detail, list, and user queries. */
export function useArchiveSpace() {
  const { agoraService } = useAgoraConfig();
  const { invalidateSpaceLists, invalidateSpace, invalidateUserSpaces } = useSpacesQueryInvalidation();

  return useOptimizedMutation<{ success: boolean; archived: boolean }, Error, { id: string; userId: string }>({
    mutationFn: ({ id }) => agoraService.archiveRoom(id),
    onSuccess: (_data, { id, userId }) => {
      invalidateSpace(id);
      invalidateSpaceLists();
      if (userId) invalidateUserSpaces(userId);
    },
  });
}
