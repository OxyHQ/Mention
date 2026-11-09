import { getServiceOxyClient } from './oxyHelpers';
import { logger } from './logger';
import { metrics } from './metrics';

/**
 * Every bulk read of Oxy users in the backend goes through here.
 *
 * `users.getMany` folds a failed chunk into "not returned", so a timeout and a
 * deleted account were the same answer, and a caller could not tell which to act
 * on (a collaborator was reported "unknown" because Oxy blipped). `lookupMany`
 * keeps the three apart: `found`, `missing` (Oxy answered without them), and
 * `failed` (Oxy could not be asked). This helper adds the one thing every caller
 * needs on top: the counts, labelled by the caller, so a batch that spends the
 * shared Oxy budget is attributable to the code that sent it.
 *
 * The result never rejects for a chunk failure; callers decide what a failed id
 * means for them (retry, degrade, or refuse).
 */

/** The caller of a bulk read, as a metric label. One entry per call site. */
export type OxyUserReadSource =
  | 'post_hydration'
  | 'federation.delivery_senders'
  | 'federation.follow_delivery'
  | 'federation.move'
  | 'federation.actor_names'
  | 'federation.direct_message_recovery'
  | 'identity.mute_aliases'
  | 'post.collaborators'
  | 'curator.follower_counts'
  | 'notification.read_state'
  | 'poke.users'
  | 'web_shell.profile';

export type OxyUserLookup = Awaited<
  ReturnType<ReturnType<typeof getServiceOxyClient>['users']['lookupMany']>
>;

/**
 * The expensive parts of a profile a caller needs. Asking for only these keeps
 * the server from computing the rest (a follower count is a correlated count over
 * the follow graph; links are a document lookup). Omitted = the full profile.
 */
export type OxyUserParts = { counts?: boolean; links?: boolean };

export async function lookupOxyUsers(
  ids: readonly string[],
  source: OxyUserReadSource,
  parts: OxyUserParts = {},
): Promise<OxyUserLookup> {
  const include = [
    ...(parts.counts ? (['counts'] as const) : []),
    ...(parts.links ? (['links'] as const) : []),
  ];
  const lookup = await getServiceOxyClient().users.lookupMany([...ids], { include });
  metrics.incrementCounter('oxy_user_bulk_ids_total', ids.length, { source });
  if (lookup.failed.length > 0) {
    metrics.incrementCounter('oxy_user_bulk_failed_total', lookup.failed.length, { source });
    logger.warn('[OxyUsers] bulk read partly failed', {
      source,
      requested: ids.length,
      found: lookup.found.length,
      failed: lookup.failed.length,
      reason: lookup.error instanceof Error ? lookup.error.message : 'unknown',
    });
  }
  return lookup;
}
