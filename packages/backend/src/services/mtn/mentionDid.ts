import { buildUserDid } from '@oxyhq/core';

/**
 * MTN subject-DID helpers.
 *
 * The MTN chain is subject-keyed by the user's Oxy DID. The DID is built with
 * `@oxyhq/core`'s {@link buildUserDid} (`did:web:oxy.so:u:<oxyUserId>`) so it
 * matches EXACTLY the DID that `oxyServices.resolveDid(oxyUserId)` resolves
 * verification methods for — there is one canonical DID per Oxy account across
 * the whole ecosystem. {@link parseUserDid} is its inverse: it recovers the
 * `oxyUserId` from a subject DID so the Mention store can key its Mongo by the
 * string id without re-deriving the apex.
 *
 * The prefix is derived from `buildUserDid('')` so it can never drift from
 * core's format — a core change to the apex flows through here automatically.
 */

/** The fixed `did:web:<apex>:u:` prefix core's `buildUserDid` emits. */
const USER_DID_PREFIX = buildUserDid('');

export { buildUserDid };

/**
 * Recover the `oxyUserId` from a canonical user DID (`did:web:<apex>:u:<id>`),
 * or `null` when the input is not a well-formed user DID. A user DID has exactly
 * one id segment after the prefix (no further `:`).
 */
export function parseUserDid(did: string): string | null {
  if (!did.startsWith(USER_DID_PREFIX)) {
    return null;
  }
  const oxyUserId = did.slice(USER_DID_PREFIX.length);
  if (oxyUserId.length === 0 || oxyUserId.includes(':')) {
    return null;
  }
  return oxyUserId;
}
