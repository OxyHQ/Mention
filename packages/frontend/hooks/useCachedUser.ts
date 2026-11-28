/**
 * Reactive reads of the SDK's people (`User`, held in the signed-in account's
 * `@oxy.so/bloom-data` store — the actor cache `lib/actorCache` writes).
 */

import { useEntity } from '@oxy.so/bloom-data';
import { User as UserRecord, useUserById as useSdkUserById } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';

/** Reactively read a user by id, fetching it when it has not been read. */
export function useUserById(id?: string): User | undefined {
  const { value } = useSdkUserById(id ?? null, { enabled: Boolean(id) });
  return value;
}

/** What a list row may fill from a held copy of its person. */
export interface CachedUserSnapshot {
  username?: string;
  avatar?: string;
  color?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function toSnapshot(
  record: { username?: unknown; avatar?: unknown; color?: unknown } | undefined,
): CachedUserSnapshot | undefined {
  if (!record) return undefined;
  return {
    username: text(record.username),
    avatar: text(record.avatar),
    color: text(record.color),
  };
}

function sameSnapshot(a?: CachedUserSnapshot, b?: CachedUserSnapshot): boolean {
  return a?.username === b?.username && a?.avatar === b?.avatar && a?.color === b?.color;
}

/**
 * The held user for an id, read and subscribed to WITHOUT fetching.
 *
 * For list rows whose payload already carries what they draw (a recommendation
 * has the username, avatar and colour). {@link useUserById} would ask Oxy for
 * every row's person — five requests for a five-person rail. This still picks up
 * anything written to the record later (a batched avatar enrichment), because it
 * subscribes to the same record.
 */
export function useCachedUserSnapshot(id?: string): CachedUserSnapshot | undefined {
  return useEntity(UserRecord, id || undefined, toSnapshot, sameSnapshot);
}
