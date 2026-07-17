import type { PostContent } from '@mention/shared-types';
import type {
  NetworkConnector,
  NormalizedExternalActor,
  LocalNetworkEvent,
  LocalPostEventPayload,
} from '@oxyhq/federation';
import { logger } from '../utils/logger';
import { isFediverseSharingEnabled } from '../services/fediverseSharing';
import type { PostFederator } from '../services/serviceRegistry';

/** The Oxy user whose `fediverseSharing` consent gates a given outbound event. */
function actingOxyUserId(event: LocalNetworkEvent<PostContent>): string {
  switch (event.kind) {
    case 'post.create':
    case 'post.boost':
    case 'post.unboost':
    case 'post.update':
    case 'post.delete':
    case 'post.like':
    case 'post.unlike':
    case 'actor.update':
      return event.actorOxyUserId;
    case 'follow.add':
    case 'follow.remove':
      // `connectors.routes.ts` (`POST /federation/follow` and `/unfollow`) is
      // the only production caller that builds these events, and it gates the
      // same `isFediverseSharingEnabled` check at the route layer BEFORE
      // reaching a connector — this check here is the seam's own enforcement,
      // not the sole one, for any other caller that reaches `deliver` directly.
      return event.localOxyUserId;
    default: {
      const exhaustive: never = event;
      throw new Error(`ConnectorRegistry: unhandled local event ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Holds the enabled network connectors and fans local domain events out to them.
 *
 * Implements the {@link PostFederator} seam (the subset `PostCreationService`
 * depends on, registered via `serviceRegistry`), so creating a new local post
 * federates it to EVERY enabled connector without `PostCreationService` knowing
 * any network exists. `resolve` / `connectorFor` dispatch a handle/URI to the
 * connector that owns it (minimal here; full unified cross-network resolve is a
 * later phase).
 */
export class ConnectorRegistry implements PostFederator {
  private readonly connectors: NetworkConnector<PostContent>[];

  constructor(connectors: NetworkConnector<PostContent>[]) {
    this.connectors = connectors.filter((c) => c.enabled);
  }

  /** The enabled connectors managed by this registry. */
  list(): readonly NetworkConnector<PostContent>[] {
    return this.connectors;
  }

  /**
   * The single outbound seam: every `LocalNetworkEvent` that passes through
   * here fans out to every enabled connector gated FIRST on the acting user's
   * `fediverseSharing` consent. `post.create` (via `federateNewPost`) always
   * flows through this seam. User-initiated follow/unfollow
   * (`connectors.routes.ts`) additionally gates at the route layer, since that
   * caller invokes `connector.deliver` directly rather than through this seam
   * — both layers enforce the same check independently.
   *
   * Once past the gate, delivery is fanned out with `Promise.allSettled` so one
   * connector's failure (e.g. a transient ActivityPub network error) does NOT
   * abort delivery to the others and does NOT propagate back to the caller —
   * outbound federation is best-effort. Each rejected connector is logged with
   * its id; the method resolves once every connector has been attempted.
   */
  async deliver(event: LocalNetworkEvent<PostContent>): Promise<void> {
    const actorOxyUserId = actingOxyUserId(event);
    if (!(await isFediverseSharingEnabled(actorOxyUserId))) {
      logger.debug(`[Connectors] sharing off for ${actorOxyUserId} — skipping federation`);
      return;
    }

    const results = await Promise.allSettled(
      this.connectors.map((connector) => connector.deliver(event)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(
          `[connectors] deliver(${event.kind}) failed for connector "${this.connectors[index].id}":`,
          result.reason,
        );
      }
    });
  }

  /**
   * Federate a newly created local post outbound to every enabled connector.
   * Each connector decides what delivery means for its network (ActivityPub
   * delivers to remote followers; future connectors write their own records).
   * A thin `post.create` wrapper over {@link deliver} — kept as its own method
   * because it implements the {@link PostFederator} seam `PostCreationService`
   * depends on via `serviceRegistry`.
   */
  async federateNewPost(
    post: LocalPostEventPayload<PostContent>,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void> {
    await this.deliver({
      kind: 'post.create',
      post,
      actorOxyUserId: senderOxyUserId,
      actorUsername: senderUsername,
    });
  }

  /** The connector that owns `subject` (a handle / URI / DID), if any. */
  connectorFor(subject: string): NetworkConnector<PostContent> | undefined {
    return this.connectors.find((connector) => connector.matches(subject));
  }

  /**
   * Resolve a handle/URI/DID through the FIRST enabled connector that claims it,
   * returning a normalized actor with its Oxy user (`oxyUserId`) resolved. The
   * connector's own `resolve` usually mints the identity while upserting; this
   * runs `mapIdentity` as a fallback so the returned actor always carries an
   * `oxyUserId` when one could be resolved.
   */
  async resolve(handle: string): Promise<NormalizedExternalActor | null> {
    const connector = this.connectorFor(handle);
    if (!connector) return null;
    const actor = await connector.resolve(handle);
    if (!actor) return null;
    if (!actor.oxyUserId) {
      const oxyUserId = await connector.mapIdentity(actor);
      if (oxyUserId) return { ...actor, oxyUserId };
    }
    return actor;
  }
}
