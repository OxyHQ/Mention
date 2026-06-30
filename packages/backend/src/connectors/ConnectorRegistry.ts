import { logger } from '../utils/logger';
import type { PostFederator } from '../services/serviceRegistry';
import type {
  NetworkConnector,
  NormalizedExternalActor,
  LocalPostEventPayload,
} from './types';

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
  private readonly connectors: NetworkConnector[];

  constructor(connectors: NetworkConnector[]) {
    this.connectors = connectors.filter((c) => c.enabled);
  }

  /** The enabled connectors managed by this registry. */
  list(): readonly NetworkConnector[] {
    return this.connectors;
  }

  /**
   * Federate a newly created local post outbound to every enabled connector.
   * Each connector decides what delivery means for its network (ActivityPub
   * delivers to remote followers; future connectors write their own records).
   *
   * Delivery is fanned out with `Promise.allSettled` so one connector's failure
   * (e.g. a transient ActivityPub network error) does NOT abort delivery to the
   * others and does NOT propagate back to `PostCreationService` — the local post
   * is already persisted; outbound federation is best-effort. Each rejected
   * connector is logged with its id; the method resolves once every connector has
   * been attempted.
   */
  async federateNewPost(
    post: LocalPostEventPayload,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void> {
    const results = await Promise.allSettled(
      this.connectors.map((connector) =>
        connector.deliver({
          kind: 'post.create',
          post,
          actorOxyUserId: senderOxyUserId,
          actorUsername: senderUsername,
        }),
      ),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(
          `[connectors] federateNewPost delivery failed for connector "${this.connectors[index].id}":`,
          result.reason,
        );
      }
    });
  }

  /** The connector that owns `subject` (a handle / URI / DID), if any. */
  connectorFor(subject: string): NetworkConnector | undefined {
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
