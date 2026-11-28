import type { PostContent } from '@mention/shared-types';
import type { NetworkConnector } from '@oxy.so/federation';
import { findActorByUri } from '../db/federation/actorRepository';
import { findFollow } from '../db/federation/followRepository';
import { logger } from '../utils/logger';
import { connectorRegistry } from './index';
import { instagramGraphConnector } from './instagram/InstagramGraphConnector';
import { lookupOxyIdentities } from './oxyIdentity';

/**
 * FOLLOWING A PERSON IS FOLLOWING EVERY TRANSPORT THEY ARE REACHED THROUGH.
 *
 * One account on another network can reach Mention through several transports
 * at once: an X account through bird.makeup and mastox.eu, a Bluesky account
 * natively and through Bridgy Fed. Each carries something the others do not —
 * bird.makeup delivers retweets as `Announce`s of the original, mastox.eu has an
 * outbox to read history from — so a follow subscribes to all of them, and an
 * unfollow undoes all of them. The posts they deliver meet on their upstream
 * key (`./shared/upstreamPostKey.ts`).
 *
 * Which transports an account has is Oxy's answer, not Mention's: Oxy registers
 * every transport it verifies under the account's `canonicalAcct` and lists them
 * in `externalIdentities`. Mention never derives one.
 */

/** The account holder following or unfollowing. */
export interface LocalFollower {
  oxyUserId: string;
  username: string;
}

/**
 * Resolve the connector that owns a follow/unfollow target. Prefers the stored
 * `federated_actors.protocol` (authoritative once an actor is known), falling back
 * to shape-based `matches` (an http URI → ActivityPub, a DID → atproto).
 */
export async function resolveTargetConnector(
  target: string,
): Promise<NetworkConnector<PostContent> | undefined> {
  const stored = await findActorByUri(target);
  if (stored?.protocol) {
    const byProtocol = connectorRegistry
      .list()
      .find((connector) => connector.id === stored.protocol);
    if (byProtocol) return byProtocol;
  }
  return connectorRegistry.connectorFor(target);
}

/**
 * The OTHER transport actors of the account `actorUri` is one transport of:
 * every source Oxy lists under the same `canonicalAcct`. Empty when Oxy does not
 * know `actorUri`. Another account the same person holds on another network (a
 * proven cross-network link) is a different account and is not included.
 */
export async function otherTransportsOf(actorUri: string): Promise<string[]> {
  const [identity] = await lookupOxyIdentities([actorUri]);
  return otherTransportsIn(identity, actorUri);
}

/** {@link otherTransportsOf}, read off an Oxy lookup answer the caller already holds. */
export function otherTransportsIn(
  identity:
    | { externalIdentities: ReadonlyArray<{ actorUri: string; canonicalAcct: string }> }
    | undefined,
  actorUri: string,
): string[] {
  const own = identity?.externalIdentities.find((source) => source.actorUri === actorUri);
  if (!identity || !own) return [];
  return [
    ...new Set(
      identity.externalIdentities
        .filter((source) => source.canonicalAcct === own.canonicalAcct)
        .map((source) => source.actorUri)
        .filter((uri) => uri !== actorUri),
    ),
  ];
}

/**
 * Follow one transport actor through the connector that owns it. A followed
 * kilogram (Instagram-bridge) actor also gets its history from the Graph API:
 * the bridge only pushes what is posted after the follow, and the Instagram
 * connector backfills its own follows inside `deliver`.
 *
 * `durable` is for a caller that exits right after (a one-shot): the follow is
 * in the connector's delivery queue before this resolves, where the connector
 * offers that (`deliverDurably`). A request leaves delivery to the background.
 */
export async function followTransport(
  follower: LocalFollower,
  actorUri: string,
  connector?: NetworkConnector<PostContent>,
  options: { durable?: boolean } = {},
): Promise<void> {
  const owner = connector ?? (await resolveTargetConnector(actorUri));
  if (!owner) throw new Error('No connector owns this follow target');
  const event = {
    kind: 'follow.add' as const,
    localOxyUserId: follower.oxyUserId,
    localUsername: follower.username,
    targetActorUri: actorUri,
  };
  const durable = (owner as { deliverDurably?: NetworkConnector<PostContent>['deliver'] })
    .deliverDurably;
  await (options.durable && durable ? durable.call(owner, event) : owner.deliver(event));
}

/** Start the Graph history backfill a followed kilogram actor needs (see {@link followTransport}). */
export function backfillFollowedTransport(
  connector: NetworkConnector<PostContent>,
  actorUri: string,
): void {
  if (connector.id !== instagramGraphConnector.id) {
    void instagramGraphConnector.backfillOnFollow(actorUri);
  }
}

/**
 * Follow (or unfollow) every other transport of the account `actorUri` belongs
 * to, after the caller handled `actorUri` itself. Each transport is attempted on
 * its own; one that fails is logged and the rest still run. An unfollow undoes
 * only the transports this follower actually follows. Never throws.
 *
 * @returns how many transports were changed.
 */
export async function syncOtherTransports(
  follower: LocalFollower,
  actorUri: string,
  action: 'follow' | 'unfollow',
): Promise<number> {
  let others: string[];
  try {
    others = await otherTransportsOf(actorUri);
  } catch (err) {
    logger.warn('[Federation] could not list the account transports to follow', { err });
    return 0;
  }
  let changed = 0;
  for (const uri of others) {
    try {
      const connector = await resolveTargetConnector(uri);
      if (!connector) continue;
      if (action === 'follow') {
        await followTransport(follower, uri, connector);
        backfillFollowedTransport(connector, uri);
      } else {
        if (!(await findFollow(follower.oxyUserId, uri, 'outbound'))) continue;
        await connector.deliver({
          kind: 'follow.remove',
          localOxyUserId: follower.oxyUserId,
          localUsername: follower.username,
          targetActorUri: uri,
        });
      }
      changed += 1;
    } catch (err) {
      logger.warn(`[Federation] could not ${action} one transport of an account`, { err });
    }
  }
  return changed;
}
