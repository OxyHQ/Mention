import { describeDriverError, isUniqueViolation } from '@oxy.so/db';
import { upsertActor } from '../../db/federation/actorRepository';
import { reconcileActorIdentityProjection } from '../../services/ActorIdentityProjectionService';
import { logger } from '../../utils/logger';
import { resolveAvatarUrl } from '../../utils/mediaResolver';
import { metrics } from '../../utils/metrics';
import { resolveOxyIdentity } from '../oxyIdentity';
import type { NormalizedExternalActor } from '@oxy.so/federation';
import {
  igUserIdFromActorUri,
  INSTAGRAM_GRAPH_NETWORK_ID,
  INSTAGRAM_IDENTITY_DOMAIN,
  instagramUsernameOfActor,
} from './constants';

/** Same counter the atproto upsert increments, labelled by protocol. */
const ACTOR_UPSERT_FAILED_METRIC = 'federated_actor_upsert_failed_total';

/**
 * Cache an `instagram-graph` actor — one Oxy resolved through Meta's Graph API —
 * in `federated_actors`, and answer the normalized actor with its Oxy user.
 *
 * Oxy owns the profile (name, biography, the mirrored avatar) and the identity;
 * Mention asks it, never Meta, for those — the same division the atproto
 * connector keeps. So resolving a profile spends NO Graph budget: the counts and
 * posts arrive with the first post sync.
 *
 * The row: `uri` = `instagram-graph:<id>`, `domain` = `instagram.com`,
 * `username` = the Instagram username, `acct` = `networkAcct` = `<u>@instagram.com`.
 * A kilogram actor for the same person keeps its own row (its `domain` is the
 * bridge), so the `(domain, username)` / `acct` uniques do not collide; a SECOND
 * `instagram-graph` row claiming the same username (a released and re-registered
 * handle) does, and the upsert fails closed exactly like the atproto one.
 */
export async function fetchAndUpsertInstagramGraphActor(actorUri: string): Promise<NormalizedExternalActor | null> {
  if (!igUserIdFromActorUri(actorUri)) return null;

  let resolved: Awaited<ReturnType<typeof resolveOxyIdentity>>;
  try {
    resolved = await resolveOxyIdentity({ actorUri, protocol: INSTAGRAM_GRAPH_NETWORK_ID });
  } catch (err) {
    logger.warn('[instagram] Oxy identity resolution failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const canonicalAcct = resolved.externalIdentity.canonicalAcct;
  const username = instagramUsernameOfActor({ networkAcct: canonicalAcct });
  if (!username || resolved.externalIdentity.protocol !== INSTAGRAM_GRAPH_NETWORK_ID) {
    logger.warn('[instagram] Oxy returned a non-Instagram identity for an instagram-graph actor');
    return null;
  }

  const acct = `${username}@${INSTAGRAM_IDENTITY_DOMAIN}`;
  const avatarUrl = resolveAvatarUrl(resolved.user.avatar);
  try {
    const row = await upsertActor(
      actorUri,
      {
        protocol: INSTAGRAM_GRAPH_NETWORK_ID,
        username,
        domain: INSTAGRAM_IDENTITY_DOMAIN,
        acct,
        networkAcct: canonicalAcct,
        summary: resolved.user.bio ?? '',
        avatarUrl,
        type: 'Person',
        manuallyApprovesFollowers: false,
        discoverable: true,
        memorial: false,
        suspended: false,
        lastFetchedAt: new Date(),
      },
      [],
    );
    if (!row) return null;
  } catch (err) {
    // Never the raw error: postgres.js attaches the statement and its parameters.
    const failure = describeDriverError(err);
    const reason = isUniqueViolation(err) ? failure.constraint ?? 'unique_violation' : 'other';
    metrics.incrementCounter(ACTOR_UPSERT_FAILED_METRIC, 1, { protocol: INSTAGRAM_GRAPH_NETWORK_ID, reason });
    logger.warn('[instagram] failed to upsert instagram-graph actor', { ...failure });
    return null;
  }

  const projection = await reconcileActorIdentityProjection({
    actorUri,
    oxyUserId: resolved.user.id,
    networkAcct: canonicalAcct,
  });
  if (projection.refusal) return null;

  return {
    network: INSTAGRAM_GRAPH_NETWORK_ID,
    externalId: actorUri,
    handle: acct,
    federatedUsername: resolved.user.username,
    instanceDomain: INSTAGRAM_IDENTITY_DOMAIN,
    displayName: resolved.user.name?.displayName,
    avatarUrl,
    bio: resolved.user.bio ?? '',
    oxyUserId: resolved.user.id,
  };
}
