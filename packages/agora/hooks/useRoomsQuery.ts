/**
 * Query Hooks & Cache Key Utilities for the Agora app
 *
 * useOptimizedQuery / useOptimizedMutation are thin wrappers around React Query
 * that set sensible defaults (5-min staleTime, 1 retry for mutations).
 * The primary value of this module is the `roomQueryKeys` factory and the
 * `useRoomsQueryInvalidation` helper which enforce consistent cache keys.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useAgoraConfig } from '@mention/agora-shared';
import type { Room, House, UserEntity } from '@mention/agora-shared';
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

export const roomQueryKeys = {
  all: ['rooms'] as const,
  lists: () => [...roomQueryKeys.all, 'list'] as const,
  list: (status?: string, type?: string) => [...roomQueryKeys.lists(), status, type] as const,
  details: () => [...roomQueryKeys.all, 'detail'] as const,
  detail: (id: string) => [...roomQueryKeys.details(), id] as const,
  userRooms: (userId: string) => [...roomQueryKeys.all, 'user', userId] as const,
  followers: (userId: string) => ['followers', userId] as const,
  following: (userId: string) => ['following', userId] as const,
} as const;

export const houseQueryKeys = {
  all: ['houses'] as const,
  lists: () => [...houseQueryKeys.all, 'list'] as const,
  publicList: () => [...houseQueryKeys.lists(), 'public'] as const,
  myHouses: (userId: string) => [...houseQueryKeys.lists(), 'mine', userId] as const,
  userHouses: (userId: string) => [...houseQueryKeys.lists(), 'user', userId] as const,
  detail: (id: string) => [...houseQueryKeys.all, 'detail', id] as const,
} as const;

// ---------------------------------------------------------------------------
// Invalidation helper
// ---------------------------------------------------------------------------

export function useRoomsQueryInvalidation() {
  const queryClient = useQueryClient();

  return {
    /** Invalidate all room list queries (any status filter). */
    invalidateRoomLists: () => {
      queryClient.invalidateQueries({ queryKey: roomQueryKeys.lists() });
    },

    /** Invalidate a single room detail query. */
    invalidateRoom: (id: string) => {
      queryClient.invalidateQueries({ queryKey: roomQueryKeys.detail(id) });
    },

    /** Invalidate the rooms belonging to a specific user. */
    invalidateUserRooms: (userId: string) => {
      queryClient.invalidateQueries({ queryKey: roomQueryKeys.userRooms(userId) });
    },

    /** Invalidate a user's followers list. */
    invalidateFollowers: (userId: string) => {
      queryClient.invalidateQueries({ queryKey: roomQueryKeys.followers(userId) });
    },

    /** Invalidate a user's following list. */
    invalidateFollowing: (userId: string) => {
      queryClient.invalidateQueries({ queryKey: roomQueryKeys.following(userId) });
    },

    /** Nuclear option -- invalidate every room-related query. */
    invalidateAll: () => {
      queryClient.invalidateQueries({ queryKey: roomQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: ['followers'] });
      queryClient.invalidateQueries({ queryKey: ['following'] });
    },
  };
}

// ---------------------------------------------------------------------------
// Domain hooks -- Rooms
// ---------------------------------------------------------------------------

/** Fetch a list of rooms, optionally filtered by status and/or type. */
export function useRooms(status?: string, type?: string) {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<Room[]>({
    queryKey: roomQueryKeys.list(status, type),
    queryFn: () => agoraService.getRooms(status, type),
  });
}

/** Fetch a single room by id. Disabled when id is falsy. */
export function useRoom(id: string | undefined) {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<Room | null>({
    queryKey: roomQueryKeys.detail(id!),
    queryFn: () => agoraService.getRoom(id!),
    enabled: !!id,
  });
}

interface UserRoomsResult {
  all: Room[];
  live: Room[];
  scheduled: Room[];
}

/**
 * Fetch all rooms where the given user is the host.
 * Fires three parallel requests (live, scheduled, ended) and filters by host.
 * Disabled when userId is falsy.
 */
export function useUserRooms(userId: string | undefined) {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<UserRoomsResult>({
    queryKey: roomQueryKeys.userRooms(userId!),
    queryFn: async (): Promise<UserRoomsResult> => {
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
    queryKey: roomQueryKeys.followers(userId!),
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
    queryKey: roomQueryKeys.following(userId!),
    queryFn: async () => {
      const result = await oxyServices!.getUserFollowing(userId!);
      return result.following ?? [];
    },
    enabled: !!userId && !!oxyServices,
  });
}

// ---------------------------------------------------------------------------
// Domain hooks -- Houses
// ---------------------------------------------------------------------------

/** Fetch public houses. */
export function usePublicHouses() {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<House[]>({
    queryKey: houseQueryKeys.publicList(),
    queryFn: () => agoraService.getHouses(),
  });
}

/** Fetch houses where the user has HOST role or higher. */
export function useMyHouses(userId: string | undefined) {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<House[]>({
    queryKey: houseQueryKeys.myHouses(userId!),
    queryFn: () => agoraService.getMyHouses(userId!),
    enabled: !!userId,
  });
}

/** Fetch all houses where the user is a member (any role). */
export function useUserHouses(userId: string | undefined) {
  const { agoraService } = useAgoraConfig();

  return useOptimizedQuery<House[]>({
    queryKey: houseQueryKeys.userHouses(userId!),
    queryFn: () => agoraService.getUserHouses(userId!),
    enabled: !!userId,
  });
}

interface CreateHouseInput {
  name: string;
  description?: string;
  tags?: string[];
  isPublic?: boolean;
}

/** Create a new house. Invalidates house list queries on success. */
export function useCreateHouse() {
  const { agoraService } = useAgoraConfig();
  const queryClient = useQueryClient();

  return useOptimizedMutation<House | null, Error, CreateHouseInput>({
    mutationFn: (data) => agoraService.createHouse(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: houseQueryKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

interface CreateRoomInput {
  title: string;
  description?: string;
  topic?: string;
  scheduledStart?: string;
  speakerPermission?: 'everyone' | 'followers' | 'invited';
  type?: 'talk' | 'stage' | 'broadcast';
  ownerType?: 'profile' | 'house';
  houseId?: string;
}

/** Create a new room. Invalidates room list queries on success. */
export function useCreateRoom() {
  const { agoraService } = useAgoraConfig();
  const { invalidateRoomLists } = useRoomsQueryInvalidation();

  return useOptimizedMutation<Room | null, Error, CreateRoomInput>({
    mutationFn: (data) => agoraService.createRoom(data),
    onSuccess: () => {
      invalidateRoomLists();
    },
  });
}

/** Start a room. Invalidates both the individual room and list queries. */
export function useStartRoom() {
  const { agoraService } = useAgoraConfig();
  const { invalidateRoomLists, invalidateRoom } = useRoomsQueryInvalidation();

  return useOptimizedMutation<boolean, Error, string>({
    mutationFn: (id) => agoraService.startRoom(id),
    onSuccess: (_data, id) => {
      invalidateRoom(id);
      invalidateRoomLists();
    },
  });
}

/** End a room. Invalidates both the individual room and list queries. */
export function useEndRoom() {
  const { agoraService } = useAgoraConfig();
  const { invalidateRoomLists, invalidateRoom } = useRoomsQueryInvalidation();

  return useOptimizedMutation<boolean, Error, string>({
    mutationFn: (id) => agoraService.endRoom(id),
    onSuccess: (_data, id) => {
      invalidateRoom(id);
      invalidateRoomLists();
    },
  });
}

/** Delete a room. Invalidates room list and user-specific queries on success. */
export function useDeleteRoom() {
  const { agoraService } = useAgoraConfig();
  const { invalidateRoomLists, invalidateUserRooms } = useRoomsQueryInvalidation();

  return useOptimizedMutation<boolean, Error, { id: string; userId: string }>({
    mutationFn: ({ id }) => agoraService.deleteRoom(id),
    onSuccess: (_data, { userId }) => {
      invalidateRoomLists();
      if (userId) invalidateUserRooms(userId);
    },
  });
}

/** Archive/unarchive a room. Invalidates the room detail, list, and user queries. */
export function useArchiveRoom() {
  const { agoraService } = useAgoraConfig();
  const { invalidateRoomLists, invalidateRoom, invalidateUserRooms } = useRoomsQueryInvalidation();

  return useOptimizedMutation<{ success: boolean; archived: boolean }, Error, { id: string; userId: string }>({
    mutationFn: ({ id }) => agoraService.archiveRoom(id),
    onSuccess: (_data, { id, userId }) => {
      invalidateRoom(id);
      invalidateRoomLists();
      if (userId) invalidateUserRooms(userId);
    },
  });
}
