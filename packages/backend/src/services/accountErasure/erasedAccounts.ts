/**
 * The read side of the erasure ledger for request handlers: "has Oxy told us this
 * account was deleted?" A route asks here rather than reaching into the
 * repository (the layering rule in `scripts/validate-architecture-boundaries.mjs`).
 */

import {
  isAccountErased as ledgerHasAccount,
  findErasedAccountIds,
  isErasedUsername,
} from '../../db/accountErasures/accountErasureRepository';
import { createCache } from '../../utils/cache';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

/**
 * True from the moment a verified deletion event for the account is recorded,
 * even while the erasure is still running: the profile must stop being served
 * at once, not when the last batch commits.
 */
export function erasedAccountIds(oxyUserIds: readonly string[]): Promise<Set<string>> {
  return findErasedAccountIds(oxyUserIds);
}

export async function isAccountErased(oxyUserId: string): Promise<boolean> {
  return ledgerHasAccount(oxyUserId);
}

/**
 * How long Oxy's answer for a handle is trusted. Neither can go stale in a way
 * anyone sees: the actor routes ask only for a handle no live account answers
 * for, so a handle claimed since is served as its holder's whatever is cached,
 * and an account archived since is answered from the ledger, which holds it
 * from the event on and for far longer than the "not gone" entry lives.
 */
const GONE_HANDLE_TTL_SECONDS = 24 * 60 * 60;
const NOT_GONE_HANDLE_TTL_SECONDS = 60 * 60;

const goneHandleCache = createCache({
  name: 'GoneActorHandleCache',
  ttlSeconds: GONE_HANDLE_TTL_SECONDS,
});

/**
 * Does Oxy hold this handle for an archived channel, community or other managed
 * account (`GET /federation/actor-gone/:username`)? The archive is permanent and
 * the archived row keeps the handle, so this stays true for good, with nothing
 * kept here but a cache. A person's account is never reported: its deletion is
 * answered from the ledger alone. An Oxy failure is "not gone" (the 404 this
 * answered before), and is not cached.
 */
async function isArchivedOxyHandle(username: string): Promise<boolean> {
  try {
    // `=== true`: only a boolean this function wrote answers 410, never a stray entry.
    const gone = await goneHandleCache.getOrCompute(
      `mention:ap:actor-gone:v1:${username.toLowerCase()}`,
      async () => {
        const answer = await getServiceOxyClient().serviceRequest<{ gone: boolean }>(
          'GET',
          `/federation/actor-gone/${encodeURIComponent(username)}`,
        );
        return answer.gone === true;
      },
      { ttlSecondsFor: (held) => (held ? GONE_HANDLE_TTL_SECONDS : NOT_GONE_HANDLE_TTL_SECONDS) },
    );
    return gone === true;
  } catch (error) {
    logger.warn('[Federation] Oxy actor-gone lookup failed; answering 404', { username, error });
    return false;
  }
}

/**
 * Is `/ap/users/<username>` a DELETED actor, to be answered `410 Gone` rather
 * than 404 (`@oxy.so/federation`'s `isActorGone`)? Asked only after the actor
 * routes found no federating account for the handle, so a handle someone has
 * claimed since is served as theirs. Two sources, the ledger first:
 *
 *  - the erasure ledger, from the moment the deletion event is recorded, for as
 *    long as it keeps the handle (`ERASURE_USERNAME_RETENTION_DAYS` after the
 *    erasure completes), which outlasts the Delete's whole retry budget. This is
 *    the only answer for a person's account;
 *  - Oxy, for an archived channel, community or other managed account, which is
 *    gone for good.
 */
export async function isErasedActorHandle(username: string): Promise<boolean> {
  return (await isErasedUsername(username)) || isArchivedOxyHandle(username);
}
