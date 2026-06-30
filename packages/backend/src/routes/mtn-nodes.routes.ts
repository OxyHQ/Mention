/**
 * MTN User-Node Routes (MTN Protocol — B3 user nodes)
 *
 * Mounted at `/mtn/nodes` (behind `optionalAuth`, which populates `req.user` for
 * a valid session). The authed routes enforce auth INTERNALLY (`req.user?.id`),
 * mirroring how `/federation` + `/starter-packs` are mounted in `server.ts`:
 *  - `GET    /mtn/nodes/me`                  (auth) — the caller's node + status.
 *  - `DELETE /mtn/nodes/me`                  (auth) — revoke the caller's node.
 *  - `POST   /mtn/nodes/managed`             (auth) — provision a managed vault.
 *  - `POST   /mtn/nodes/ingest/notify/:userId` (public) — a 202 ingest HINT.
 *
 * The owner id is ALWAYS resolved server-side from the session (never the body).
 * Node REGISTRATION is not here — a node is registered by publishing a signed
 * `app.mention.node` record onto the user's chain, which materializes the cache
 * via `MentionNodeRegistryService`. These routes only read/revoke that cache and
 * trigger background sync; NOTHING here ever fetches a node inline (revocation is
 * a local cache write; the notify only schedules background work) — the read-path
 * invariant holds.
 */

import { Router, Request, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../utils/logger';
import {
  getUserNode,
  removeNode,
  provisionManagedVault,
} from '../services/mtn/MentionNodeRegistryService';
import { ingestFromNode } from '../services/mtn/MentionNodeSyncService';
import MentionUserNode, { type IMentionUserNode } from '../models/MentionUserNode';

const router = Router();

/** Public projection of a node row (drops Mongo internals). */
function serializeNode(node: IMentionUserNode): Record<string, unknown> {
  return {
    nodeDid: node.nodeDid,
    endpoint: node.endpoint,
    nodePublicKey: node.nodePublicKey,
    mode: node.mode,
    managed: node.managed,
    controller: node.controller,
    status: node.status,
    lastSeenAt: node.lastSeenAt,
    lastProbeAt: node.lastProbeAt,
    lastError: node.lastError,
    cursor: node.cursor,
    lastSyncedAt: node.lastSyncedAt,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/** GET /mtn/nodes/me — the caller's registered node (or `{ node: null }`). */
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const node = await getUserNode(oxyUserId);
    return res.json({ node: node ? serializeNode(node) : null });
  } catch (error) {
    logger.error('GET /mtn/nodes/me failed', error);
    return res.status(500).json({ message: 'Failed to load node' });
  }
});

/** DELETE /mtn/nodes/me — revoke the caller's node registration. */
router.delete('/me', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const revoked = await removeNode(oxyUserId);
    if (!revoked) {
      return res.status(404).json({ message: 'No active node registration to revoke' });
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error('DELETE /mtn/nodes/me failed', error);
    return res.status(500).json({ message: 'Failed to revoke node' });
  }
});

/**
 * POST /mtn/nodes/managed — provision a Mention-operated MANAGED vault for the
 * caller ("Create your vault"). The owner id is resolved from the session ONLY
 * (the body is never read), Mention custodial-signs the node registration onto
 * the caller's chain, and the materialized node is returned. Idempotent: an
 * existing active managed vault is refreshed in place, not duplicated.
 *
 * A missing custodial key or unconfigured managed-node fleet is server config, so
 * it answers 503 (try later) — never a silent broken vault.
 */
router.post('/managed', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const result = await provisionManagedVault(oxyUserId);
    if (!result.ok) {
      switch (result.reason) {
        case 'custodial_key_unconfigured':
        case 'managed_endpoint_unconfigured':
          return res.status(503).json({ message: 'Managed vaults are not available right now' });
        default:
          return res.status(500).json({ message: 'Failed to provision managed vault' });
      }
    }

    return res.status(201).json({ node: serializeNode(result.node) });
  } catch (error) {
    logger.error('POST /mtn/nodes/managed failed', error);
    return res.status(500).json({ message: 'Failed to provision managed vault' });
  }
});

/**
 * POST /mtn/nodes/ingest/notify/:userId — a HINT (no authority) that a user's
 * node has new records. The target is resolved server-side from the path param
 * ONLY; the request body is never read or trusted. If the named user has a
 * registered (non-revoked) node, a background ingest is fired-and-forget (never
 * awaited), then fully re-verified by the worker (a notify can never inject
 * data). Always answers 202: it is a fire-and-forget hint, not a probe.
 *
 * Unauthenticated by design (it only re-pulls the user's OWN node and changes
 * nothing without cryptographic verification). The global rate limiter +
 * brute-force protection apply. The read path is untouched — this only schedules
 * background work.
 */
router.post('/ingest/notify/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;
  // Bound the param so a junk id never reaches the DB; an Oxy account id is a
  // short, opaque, alphanumeric string.
  if (typeof userId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(userId)) {
    void MentionUserNode.exists({ oxyUserId: userId, status: { $ne: 'revoked' } })
      .then((hasNode) => {
        if (hasNode) {
          // Detached background ingest — NEVER awaited on the request path.
          void ingestFromNode(userId);
        }
      })
      .catch((error) => {
        logger.debug('mtn/nodes ingest notify: existence check failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  return res.status(202).json({ accepted: true });
});

export default router;
