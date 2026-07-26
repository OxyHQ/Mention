import type { PostContent } from '@mention/shared-types';
import type { NetworkConnector } from '@oxyhq/federation';
import { registerPostFederator } from '../services/serviceRegistry';
import { ConnectorRegistry } from './ConnectorRegistry';
import { activityPubConnector } from './activitypub/ActivityPubConnector';
import { FEDERATION_ENABLED } from './activitypub/constants';
import { atprotoConnector } from './atproto/AtprotoConnector';
import { ATPROTO_ENABLED } from './atproto/constants';

/**
 * Network-connector bootstrap.
 *
 * Reads the validated feature gates and builds the registry. Runtime bootstrap
 * explicitly calls {@link initConnectors} to register it as the
 * `PostFederator` seam used by `PostCreationService`; importing route modules
 * alone never mutates the service registry.
 *
 * The registry is always registered (even with zero enabled connectors) so
 * `getPostFederator()` never throws; `federateNewPost` simply becomes a no-op
 * when federation is disabled — preserving the prior behavior where the facade
 * was always registered and its `federateNewPost` short-circuited internally.
 *
 * Connectors gate on their own env flags:
 *  - ActivityPub  → `FEDERATION_ENABLED` (default on; `false` disables).
 *  - atproto      → `ATPROTO_ENABLED` (default OFF; `true` enables Bluesky read).
 *
 * Order matters for `connectorFor`/`resolve`: ActivityPub is registered first so
 * a fediverse `@user@host` acct is claimed by it, and the atproto connector
 * claims the remaining shapes (bare handles / DIDs / AT-URIs).
 */
const connectors: NetworkConnector<PostContent>[] = [];

if (FEDERATION_ENABLED) {
  connectors.push(activityPubConnector);
}

if (ATPROTO_ENABLED) {
  connectors.push(atprotoConnector);
}

export const connectorRegistry = new ConnectorRegistry(connectors);

let initialized = false;

/**
 * Explicit, idempotent runtime bootstrap. Keeping registration here makes the
 * lifecycle visible and prevents tests or pure route composition from changing
 * global service state merely by importing a module.
 */
export function initConnectors(): ConnectorRegistry {
  if (!initialized) {
    registerPostFederator(connectorRegistry);
    initialized = true;
  }
  return connectorRegistry;
}
