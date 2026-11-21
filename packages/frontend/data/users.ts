import { useEntities, useEntity } from '@oxy.so/bloom-data';
import type { User as OxyUser } from '@oxy.so/core';
import { User } from '@oxy.so/services/ui/client';
import { useMemo } from 'react';

/**
 * People, as the Oxy SDK holds them: once per account, in its `User` entity
 * (`@oxy.so/services/ui/client`). Every person Mention reads is written there
 * (`storeUsers`, or a post's `refs`), so a profile edit, a new picture or a
 * rename reaches every surface that shows that person, and a copy hydrated
 * before the edit cannot put the old one back: `User` keeps the copy with the
 * later `updatedAt`.
 *
 * A record that embeds a person one or two keys deep refers to `User` (see
 * `data/posts`) and needs nothing here. This module is for the people a row
 * holds in a list (a byline, a notification's actors) or receives from a
 * surface that did not store them (a search result, a slice's reposter).
 */

/**
 * A person as `User` holds them: a slice of an Oxy user (a feed author carries
 * less than a profile read), always with its id.
 */
export type HeldUser = Partial<OxyUser> & { id: string };

/** A person a surface holds its own copy of. */
interface PersonSnapshot {
  id?: string;
  updatedAt?: unknown;
}

/** When a copy was last changed at Oxy, in ms; a copy without `updatedAt` has no date. */
function updatedAtOf(person: PersonSnapshot): number {
  const at = typeof person.updatedAt === 'string' ? Date.parse(person.updatedAt) : Number.NaN;
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * The held copy of a person, when it should be shown over a surface's own:
 * it carries an Oxy date (so it is a real copy, never the "Unknown user"
 * placeholder an outage returns), and that date is not older than the
 * surface's copy. Otherwise the surface's copy is newer, or nothing can tell,
 * and it stands.
 */
export function currentHeldUser(
  snapshot: PersonSnapshot,
  held: HeldUser | undefined,
): HeldUser | undefined {
  if (!held) return undefined;
  const heldAt = updatedAtOf(held);
  return heldAt !== Number.NEGATIVE_INFINITY && heldAt >= updatedAtOf(snapshot) ? held : undefined;
}

/**
 * A surface's copy of a person with the held one laid over it (see
 * {@link currentHeldUser}). Fields only the surface's copy has (a byline
 * author's `role`) are kept. Returns `snapshot` itself when nothing is laid
 * over it. Pure, so a render may call it inside a `useMemo`.
 */
export function withHeldUser<T extends PersonSnapshot>(snapshot: T, held: HeldUser | undefined): T {
  const current = currentHeldUser(snapshot, held);
  return current ? { ...snapshot, ...current } : snapshot;
}

/** `User`'s record as a plain object (no proxy), typed as what it holds. */
const asHeldUser = (user: ReturnType<typeof User.get>): HeldUser | undefined =>
  user as HeldUser | undefined;

/** The held copy of one person, read reactively from the account's store. */
export function useHeldUser(id: string | null | undefined): HeldUser | undefined {
  return useEntity(User, id, asHeldUser);
}

const EMPTY: ReadonlyMap<string, HeldUser> = new Map();

/** A newline never appears in an Oxy user id, so joining ids on it is unambiguous. */
const ID_SEPARATOR = '\n';

/**
 * The held copies of the people `ids` name, by id, read reactively from the
 * account's store (`useEntities`): the row re-renders when one of THEM
 * changes, never for anyone else. One read for the whole list, because a hook
 * cannot be called per element (a byline, a notification's actors).
 * `undefined` and repeated ids are ignored; an id nobody holds has no entry.
 * Lay an entry over the row's own copy with {@link withHeldUser}.
 */
export function useHeldUsers(
  ids: readonly (string | null | undefined)[],
): ReadonlyMap<string, HeldUser> {
  const key = [...new Set(ids.filter((id): id is string => Boolean(id)))].join(ID_SEPARATOR);
  const unique = useMemo(() => (key === '' ? [] : key.split(ID_SEPARATOR)), [key]);
  const held = useEntities(User, unique);
  return useMemo(() => {
    const map = new Map<string, HeldUser>();
    held.forEach((user, index) => {
      const person = asHeldUser(user);
      if (person) map.set(unique[index], person);
    });
    return map.size === 0 ? EMPTY : map;
  }, [unique, held]);
}
