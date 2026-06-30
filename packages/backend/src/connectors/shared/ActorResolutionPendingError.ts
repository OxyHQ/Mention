import type { IFederatedActor } from '../../models/FederatedActor';

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
 * Use this at federated Post-INSERT call sites where a retry is the right
 * behaviour (the inbox `Create` path). Best-effort batch contexts that should
 * skip — not retry — an unresolvable item (outbox backfill, boosted-original /
 * ancestor import) handle the null case locally rather than calling this.
 */
export function requireActorOxyUserId(
  actor: Pick<IFederatedActor, 'oxyUserId'> | null | undefined,
  actorUri: string,
  context?: string,
): string {
  const oxyUserId = actor?.oxyUserId;
  if (!oxyUserId) {
    throw new ActorResolutionPendingError(actorUri, context);
  }
  return oxyUserId;
}
