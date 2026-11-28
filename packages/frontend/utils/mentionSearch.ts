import { scanTextEntities } from '@mention/shared-types/textEntities';
import {
  hasHandleContinuation,
  mergeMentionData,
  type MentionData,
  type MentionTextValue,
} from './mentions';

/** One account the mention picker can offer. */
export interface MentionUser {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  verified?: boolean;
}

interface OxyProfileResult {
  id?: string;
  _id?: string;
  username?: string;
  handle?: string;
  name?: { displayName?: string };
  avatar?: string | null;
  profilePicture?: string;
  verified?: boolean;
}

/** Map an Oxy profile search response to picker rows, dropping unusable ones. */
export function toMentionUsers(
  results: readonly OxyProfileResult[] | null | undefined,
): MentionUser[] {
  return (results || []).flatMap((profile) => {
    const id = profile.id || profile._id;
    const username = profile.username || profile.handle || '';
    if (!id || !username) return [];
    return [
      {
        id,
        username,
        displayName: profile.name?.displayName,
        avatar: profile.avatar || profile.profilePicture || undefined,
        verified: profile.verified || false,
      },
    ];
  });
}

/**
 * The one account whose username IS the typed handle, ignoring case.
 *
 * `null` when no result matches, and also when two different accounts do —
 * guessing between them would address a notification to someone the author
 * never picked.
 */
export function findExactMentionUser(
  users: readonly MentionUser[],
  handle: string,
): MentionUser | null {
  const wanted = handle.toLowerCase();
  let found: MentionUser | null = null;
  for (const user of users) {
    if (user.username.toLowerCase() !== wanted) continue;
    if (found && found.id !== user.id) return null;
    found = user;
  }
  return found;
}

/**
 * The results of every mention search one composer session has run.
 *
 * The picker and the typed-handle resolution read the SAME cache, so a handle
 * the picker already searched for costs no second request when it is completed,
 * and concurrent searches for one query share one request.
 */
export interface MentionSearchCache {
  /** Results already in memory for exactly this query, or `undefined`. */
  peek: (query: string) => MentionUser[] | undefined;
  /** Results for this query: from memory, the request in flight, or one new request. */
  search: (query: string) => Promise<MentionUser[]>;
  /**
   * The account a typed handle names, from memory only: the user, `null` when
   * the cached results name nobody unambiguously, or `undefined` when nothing
   * searched so far can answer.
   */
  findUser: (handle: string) => MentionUser | null | undefined;
}

/** The tab composer lives as long as the app does; bound what it remembers. */
const MAX_CACHED_QUERIES = 200;

export function createMentionSearchCache(
  fetchUsers: (query: string) => Promise<MentionUser[]>,
): MentionSearchCache {
  const results = new Map<string, MentionUser[]>();
  const inFlight = new Map<string, Promise<MentionUser[]>>();

  const keyOf = (query: string) => query.toLowerCase();

  const peek = (query: string) => results.get(keyOf(query));

  const search = (query: string) => {
    const key = keyOf(query);
    const cached = results.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = inFlight.get(key);
    if (pending) return pending;

    const request = fetchUsers(query)
      .then((users) => {
        if (results.size >= MAX_CACHED_QUERIES) {
          const oldest = results.keys().next().value;
          if (oldest !== undefined) results.delete(oldest);
        }
        results.set(key, users);
        return users;
      })
      .finally(() => {
        // A failure is not remembered, so the next completion may try again.
        inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  };

  const findUser = (handle: string) => {
    const exact = peek(handle);
    if (exact) return findExactMentionUser(exact, handle);
    // A search for a prefix (`ali` while typing `alice`) may already have
    // returned the account. Usernames are unique, so any exact hit is the one.
    for (const users of results.values()) {
      const user = findExactMentionUser(users, handle);
      if (user) return user;
    }
    return undefined;
  };

  return { peek, search, findUser };
}

/**
 * Whether the author has finished typing the handle that ends at `end`: the
 * next character is whitespace or punctuation. `.` and `-` may continue a
 * handle (`@alice.bsky`), so they only finish one when something that cannot
 * continue it follows.
 */
function isCompletedHandle(text: string, end: number): boolean {
  const next = text[end];
  // `@alice@` is the start of a federated handle, not a finished local one.
  if (next === undefined || hasHandleContinuation(next)) return false;
  if (next === '.' || next === '-') {
    const after = text[end + 1];
    return after !== undefined && !hasHandleContinuation(after);
  }
  return true;
}

export interface TypedMentionResolution {
  value: MentionTextValue;
  /** Completed handles nothing in memory can answer yet. */
  pending: string[];
}

/**
 * Turn typed `@handle`s into mentions, as if each had been picked.
 *
 * Operates on STORAGE text, so a mention already chosen is a placeholder and
 * is never looked at again. Only the shared scanner's `bareHandle` spans are
 * considered: a handle inside a URL or an email is part of that entity, and a
 * federated `@a@b.tld` is its own kind the server resolves. With
 * `completedOnly`, a handle still being typed is left for the picker.
 */
export function resolveTypedMentions(
  value: MentionTextValue,
  findUser: (handle: string) => MentionUser | null | undefined,
  { completedOnly }: { completedOnly: boolean },
): TypedMentionResolution {
  const pending: string[] = [];
  const added: MentionData[] = [];
  let text = '';
  let cursor = 0;

  for (const entity of scanTextEntities(value.text)) {
    if (entity.kind !== 'bareHandle') continue;
    if (completedOnly && !isCompletedHandle(value.text, entity.end)) continue;

    const user = findUser(entity.value);
    if (user === undefined) {
      if (!pending.includes(entity.value)) pending.push(entity.value);
      continue;
    }
    if (user === null) continue;

    text += `${value.text.slice(cursor, entity.start)}[mention:${user.id}]`;
    cursor = entity.end;
    added.push({
      userId: user.id,
      username: user.username,
      displayName: user.displayName?.trim() || user.username,
    });
  }

  if (added.length === 0) return { value, pending };
  return {
    value: {
      text: text + value.text.slice(cursor),
      mentions: mergeMentionData(value.mentions, added),
    },
    pending,
  };
}
