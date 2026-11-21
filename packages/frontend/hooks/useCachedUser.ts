/**
 * A user by id through the SDK's React Query read, for the live-room surfaces,
 * which warm the same query key themselves (`useRoomUsers`, `liveConfig`). Every
 * other surface reads people from the Oxy SDK's `User` (`data/users`).
 */
import { useUserById as useSdkUserById } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';

/** Reactively read a cached user by id. Subscribes to the React Query cache. */
export function useUserById(id?: string): User | undefined {
  const { data } = useSdkUserById(id ?? null, { enabled: Boolean(id) });
  return data ?? undefined;
}
