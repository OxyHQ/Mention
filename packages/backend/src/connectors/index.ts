import { registerPostFederator } from '../services/serviceRegistry';
import type { NetworkConnector } from './types';
import { ConnectorRegistry } from './ConnectorRegistry';
import { activityPubConnector } from './activitypub/ActivityPubConnector';
import { FEDERATION_ENABLED } from './activitypub/constants';
import { atprotoConnector } from './atproto/AtprotoConnector';
import { ATPROTO_ENABLED } from './atproto/constants';

/**
 * Network-connector bootstrap.
 *
 * Reads the env gates, instantiates the enabled connectors, builds the registry,
 * and registers it as the `PostFederator` (the seam `PostCreationService.create`
 * already uses via `serviceRegistry`). This REPLACES the old import side-effect
 * that registered the deleted `FederationService` facade — so `server.ts` only
 * needs `import './src/connectors'` at bootstrap and `PostCreationService` itself
 * does not change.
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
const connectors: NetworkConnector[] = [];

if (FEDERATION_ENABLED) {
  connectors.push(activityPubConnector);
}

if (ATPROTO_ENABLED) {
  connectors.push(atprotoConnector);
}

export const connectorRegistry = new ConnectorRegistry(connectors);

registerPostFederator(connectorRegistry);

/**
 * Idempotent explicit entry point. Importing this module already performs the
 * registration above (side-effect, mirroring the prior FederationService
 * pattern); calling this returns the registry for callers that prefer an
 * explicit bootstrap step.
 */
export function initConnectors(): ConnectorRegistry {
  return connectorRegistry;
}
