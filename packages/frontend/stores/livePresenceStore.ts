import { useCallback, useSyncExternalStore } from 'react';

/**
 * Who is live in a Syra room right now, keyed by Oxy user id.
 *
 * ONE writer — `LivePresencePoller`, mounted once at the app root — owns the
 * `['live-users']` query and pushes each result in through
 * {@link setLivePresence}. Every avatar reads its own key through
 * {@link useLiveUser}, so a post header costs a `useSyncExternalStore`
 * subscription to one key instead of a TanStack QueryObserver plus a freshly
 * built `Map` of every live user.
 *
 * Updates are diffed per key: when user A goes live, only A's subscribers are
 * notified. The snapshot a subscriber reads is the room id string (or
 * `undefined`), which is stable across unrelated updates, so React bails out
 * for everyone else too.
 *
 * Per-viewer state: `AccountSwitchReset` calls {@link resetLivePresence} on
 * every identity change, and the poller re-keys its query by viewer id.
 */

type Listener = () => void;

let roomByUser = new Map<string, string>();
const keyListeners = new Map<string, Set<Listener>>();
let subscriberCount = 0;
const demandListeners = new Set<Listener>();

export interface LiveUserEntryLike {
  userId?: string | null;
  roomId?: string | null;
}

function notifyKey(userId: string): void {
  const listeners = keyListeners.get(userId);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) listener();
}

function notifyDemand(): void {
  for (const listener of Array.from(demandListeners)) listener();
}

/**
 * Replace the live set with `entries`, notifying only the users whose room
 * changed (went live, went offline, or moved rooms).
 */
export function setLivePresence(entries: readonly LiveUserEntryLike[] | undefined): void {
  const next = new Map<string, string>();
  for (const entry of entries ?? []) {
    if (entry.userId && entry.roomId) next.set(entry.userId, entry.roomId);
  }

  const changed: string[] = [];
  for (const [userId, roomId] of next) {
    if (roomByUser.get(userId) !== roomId) changed.push(userId);
  }
  for (const userId of roomByUser.keys()) {
    if (!next.has(userId)) changed.push(userId);
  }

  roomByUser = next;
  for (const userId of changed) notifyKey(userId);
}

/** Drop every live entry (account switch / sign-out). */
export function resetLivePresence(): void {
  setLivePresence(undefined);
}

/** Non-reactive read, for callers outside React. */
export function getLiveRoomId(userId: string | undefined): string | undefined {
  return userId ? roomByUser.get(userId) : undefined;
}

function subscribeToUser(userId: string, listener: Listener): () => void {
  let listeners = keyListeners.get(userId);
  if (!listeners) {
    listeners = new Set();
    keyListeners.set(userId, listeners);
  }
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) notifyDemand();

  return () => {
    const current = keyListeners.get(userId);
    if (current?.delete(listener)) {
      if (current.size === 0) keyListeners.delete(userId);
      subscriberCount -= 1;
      if (subscriberCount === 0) notifyDemand();
    }
  };
}

const noopUnsubscribe = () => undefined;

export interface LiveUserState {
  /** Whether the user is currently live in a Syra room. */
  isLive: boolean;
  /** The live room to join, or `undefined` when the user is not live. */
  roomId: string | undefined;
}

/**
 * Keyed, reactive read of one user's live state. Re-renders only when THIS
 * user's room changes. `userId` undefined reads as not live and subscribes to
 * nothing (it also does not count as demand for the poll).
 */
export function useLiveUser(userId: string | undefined): LiveUserState {
  const subscribe = useCallback(
    (listener: Listener) => (userId ? subscribeToUser(userId, listener) : noopUnsubscribe),
    [userId],
  );
  const getSnapshot = useCallback(() => getLiveRoomId(userId), [userId]);
  const roomId = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { isLive: roomId !== undefined, roomId };
}

function subscribeToDemand(listener: Listener): () => void {
  demandListeners.add(listener);
  return () => {
    demandListeners.delete(listener);
  };
}

const getHasDemand = () => subscriberCount > 0;

/**
 * Whether any mounted component is reading live presence. The poller only runs
 * its query while this is true, which keeps the old behaviour: the app polls
 * while an avatar (or profile header) is on screen and not otherwise. Flips
 * only on the 0 <-> 1 transitions, so it re-renders the poller alone and rarely.
 */
export function useHasLivePresenceDemand(): boolean {
  return useSyncExternalStore(subscribeToDemand, getHasDemand, getHasDemand);
}
