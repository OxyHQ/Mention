import type { FederatedActorRecord } from '../../db/federation/actorRecord';

/**
 * Thrown when a federated Post is about to be created but the remote actor has
 * NOT yet been resolved to an Oxy user (`oxyUserId` is missing).
 *
 * Every federated post MUST carry a real Oxy author — never a null author. When
 * actor→Oxy resolution failed or is still pending (e.g. Oxy was unreachable when
 * `ActorService.fetchRemoteActor` ran its `PUT /users/resolve`), the insert is
 * DEFERRED rather than persisted as an orphan:
 *
 *  - In the BullMQ inbox worker, throwing fails the job, which retries with
 *    bounded exponential backoff. On a later attempt (Oxy reachable) the actor
 *    resolves and the post inserts with a real author. A permanently
 *    unresolvable actor (dead remote instance) exhausts the attempts and the
 *    activity is dropped — never stored as an orphan.
 *  - In the inline (no-Redis) fallback, it surfaces as a 500 from the inbox
 *    endpoint, so the remote re-delivers per ActivityPub.
 *
 * The outbox backfill applies the same policy without the throw: a page's note
 * whose author is known but not yet linked is held back, and the run reports
 * `author-pending` and is not stamped done, so the next run retries it from the
 * last completed cursor instead of paging past it. A dependency import (boosted
 * original, reply ancestor, quoted note) answers null instead: its caller's own
 * post is stored either way.
 */
export class ActorResolutionPendingError extends Error {
  /** The remote actor URI whose Oxy resolution is still pending. */
  readonly actorUri: string;

  constructor(actorUri: string, context?: string) {
    super(
      `Actor ${actorUri} is not yet resolved to an Oxy user${context ? ` (${context})` : ''}; deferring federated post insert`,
    );
    this.name = 'ActorResolutionPendingError';
    this.actorUri = actorUri;
  }
}

/**
 * Assert that a resolved actor carries a non-empty Oxy user id, returning it as
 * a guaranteed `string`. Throws {@link ActorResolutionPendingError} when the
 * actor is missing or has no `oxyUserId`, so the federated post insert is
 * deferred (and retried) instead of persisting a null author.
 *
 * Used by the inbox `Create`, whose retry is the BullMQ job's. The outbox and
 * the dependency import retry or decline in their own terms (see the class).
 */
export function requireActorOxyUserId(
  actor: Pick<FederatedActorRecord, 'oxyUserId'> | null | undefined,
  actorUri: string,
  context?: string,
): string {
  const oxyUserId = actor?.oxyUserId;
  if (!oxyUserId) {
    throw new ActorResolutionPendingError(actorUri, context);
  }
  return oxyUserId;
}
