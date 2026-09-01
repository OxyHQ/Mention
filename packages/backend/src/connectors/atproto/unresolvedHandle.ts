/**
 * Bluesky's sentinel for a handle that does not verify — one protocol fact,
 * deliberately in its own module.
 *
 * It lives here rather than in `./constants` because it once had TWO consumers
 * on opposite sides of the app: the atproto connector, which must not key an
 * actor on it, and the Mongo→Postgres copier, which had to recognise the rows
 * already written under it. `./constants` reads `../../config` at module load
 * and `config/index.ts` THROWS on an incomplete environment, so a standalone
 * tool importing it would have refused to start without the app's full runtime
 * configuration. The copier is gone; the separation stays, because the reason it
 * was worth having applies to the next one-shot too.
 *
 * The alternative was a second copy of the string. A duplicated sentinel drifts
 * silently, and the whole failure this guards against is a value that identifies
 * nobody being used as an identity.
 */

/**
 * The literal handle an AppView serves when a handle's bidirectional DNS/DID
 * verification FAILS.
 *
 * It is an ERROR STRING, not an identity: every account whose handle cannot be
 * verified gets the same one, so it is the single value in the whole atproto
 * namespace that is guaranteed NOT to be unique. Keying an actor on it collapses
 * every such account onto one identity — in Mongo that silently produced 21 rows
 * sharing `acct: 'handle.invalid'`, and against `federated_actors_acct_key` it
 * refuses every account after the first. Use {@link isUnresolvedAtprotoHandle}
 * and fall back to the DID, which is the stable identifier atproto actually
 * guarantees.
 */
export const UNRESOLVED_HANDLE = 'handle.invalid';

/**
 * True when a handle is the unresolved-handle sentinel rather than a real one.
 *
 * Compared case-insensitively on the trimmed value: the sentinel arrives in the
 * same `handle` field as a real handle, which is DNS and therefore already
 * case-insensitive, so a check that only matched the exact lower-case spelling
 * would be a narrower question than the one being asked.
 */
export function isUnresolvedAtprotoHandle(handle: string): boolean {
  return handle.trim().toLowerCase() === UNRESOLVED_HANDLE;
}
