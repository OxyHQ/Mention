/**
 * Mention Node Registry Service (MTN Protocol — B3 user nodes)
 *
 * Materializes and maintains the operational {@link MentionUserNode} cache from
 * the AUTHORITATIVE source — a user's signed `app.mention.node` record on their
 * MTN hash chain (`collection: 'app.mention.node'`, `rkey: 'self'`). The signed
 * record is verified + stored by the chain engine (`verifyAndStoreRecord`); this
 * service projects its `record` payload into the fast cache and keeps the
 * liveness badge current.
 *
 * A faithful port of oxy-api's `nodeRegistry.service.ts`, scoped to `app.mention.*`
 * and keyed by `oxyUserId` (a string — Mention has no `User` collection).
 *
 * ## Absolute read-path invariant
 *
 * Every node fetch here goes through `@oxyhq/core/server`'s `safeFetch`
 * (HTTPS-only, private-IP denylist, DNS-pinned, bounded redirects) and runs ONLY
 * in the background — the post-registration probe (fire-and-forget) and the
 * periodic sweep. No function in a request's read path ever awaits a node: a
 * down node leaves the cache stale-but-instant. `probeLiveness` and
 * `sweepNodeLiveness` NEVER throw into a caller.
 */

import type { UpdateQuery } from 'mongoose';
import { z } from 'zod';
import { signEnvelope, type SignedRecordSigningFields } from '@oxyhq/protocol';
import { safeFetch } from '@oxyhq/core/server';
import MentionUserNode, {
  type IMentionUserNode,
  type MentionUserNodeMode,
  type MentionUserNodeController,
} from '../../models/MentionUserNode';
import { logger } from '../../utils/logger';
import { buildUserDid } from './mentionDid';
import { getHead } from './MentionRepoLogService';
import { verifyAndStoreRecord } from './MentionRecordService';
import {
  getMentionCustodialIssuer,
  getMentionCustodialPrivateKey,
  getMentionCustodialPublicKey,
} from './mentionRecordEnv';
import {
  MENTION_NODE_COLLECTION,
  MENTION_NODE_RKEY,
  MENTION_NODE_WELL_KNOWN_PATH,
  MENTION_NODE_PROBE_TIMEOUT_MS,
  MENTION_NODE_LAST_ERROR_MAX_LEN,
  MENTION_NODE_LIVENESS_SWEEP_BATCH,
  MENTION_NODE_BASE_URL_ENV,
  MENTION_NODE_USER_PATH_PREFIX,
  MENTION_NODE_PUBLIC_KEY_ENV,
  MENTION_NODE_MANAGED_MODE,
} from './mentionNodes.constants';

/** The open envelope `type` Mention signs every v2 app record under (incl. node). */
const MENTION_RECORD_TYPE = 'app_record';

/** Retry budget for the multi-writer chain-head race when appending the node record. */
const MAX_PROVISION_ATTEMPTS = 4;

/**
 * How a managed `app.mention.node` record was projected into the cache.
 * Self-hosted registrations omit this (defaults below); the managed path passes it.
 */
export interface MaterializeNodeOptions {
  /** Mention operates this node on the user's behalf (managed vault). Default `false`. */
  managed?: boolean;
  /** Operator of the node. Default `self`. */
  controller?: MentionUserNodeController;
}

/**
 * Shape of the `record` payload inside a signed `app.mention.node` envelope. Only
 * these fields are projected into the cache; anything else is ignored.
 */
const nodeRecordSchema = z.object({
  endpoint: z.string().trim().min(1),
  nodePublicKey: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64,130}$/, 'nodePublicKey must be a secp256k1 hex key'),
  mode: z.enum(['pull', 'push']).optional(),
  nodeDid: z.string().trim().min(1).optional(),
});

/**
 * Validate + normalise a node endpoint. Returns the canonical `origin + path`
 * (trailing slash trimmed) only for a well-formed, credential-free HTTPS URL;
 * `null` otherwise. The SSRF/private-IP check itself happens later in `safeFetch`
 * at probe time — here we only reject endpoints that could never be a valid node.
 */
function normalizeHttpsEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.hostname.length === 0) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** The liveness manifest URL for a normalised node endpoint. */
function wellKnownUrl(endpoint: string): string {
  return `${endpoint}${MENTION_NODE_WELL_KNOWN_PATH}`;
}

/**
 * Project a verified `app.mention.node` signed record into the
 * {@link MentionUserNode} cache.
 *
 * Best-effort and non-throwing: the signed record is the source of truth and is
 * already persisted on the chain by the caller; a malformed `record` payload
 * (bad endpoint/key) simply skips materialization (logged) rather than failing.
 * On success the row is upserted `active` and a liveness probe is fired WITHOUT
 * being awaited.
 *
 * `options` records WHO operates the node: self-hosted by default, or
 * `{ managed: true, controller: 'oxy' }` for a managed vault. Both flags are
 * written every time so re-registering a self-hosted node over a previously
 * managed one (or vice-versa) flips the operator deterministically.
 */
export async function materializeNodeFromRecord(
  oxyUserId: string,
  record: Record<string, unknown>,
  options: MaterializeNodeOptions = {},
): Promise<IMentionUserNode | null> {
  const parsed = nodeRecordSchema.safeParse(record);
  if (!parsed.success) {
    logger.warn('MentionNodeRegistry: node record payload failed validation; skipping materialization', {
      oxyUserId,
    });
    return null;
  }

  const endpoint = normalizeHttpsEndpoint(parsed.data.endpoint);
  if (!endpoint) {
    logger.warn('MentionNodeRegistry: node record endpoint is not a valid HTTPS URL; skipping materialization', {
      oxyUserId,
    });
    return null;
  }

  const mode: MentionUserNodeMode = parsed.data.mode ?? 'pull';
  const managed = options.managed ?? false;
  const controller: MentionUserNodeController = options.controller ?? 'self';

  try {
    const node = await MentionUserNode.findOneAndUpdate(
      { oxyUserId },
      {
        $set: {
          endpoint,
          nodePublicKey: parsed.data.nodePublicKey,
          mode,
          managed,
          controller,
          status: 'active',
          ...(parsed.data.nodeDid ? { nodeDid: parsed.data.nodeDid } : {}),
        },
        $unset: { lastError: '' },
        $setOnInsert: { oxyUserId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Fire-and-forget liveness probe — NEVER awaited in the request path.
    probeLiveness(oxyUserId).catch((err) =>
      logger.debug('MentionNodeRegistry: post-registration liveness probe failed to schedule', {
        oxyUserId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    return node;
  } catch (err) {
    logger.error('MentionNodeRegistry: failed to materialize node from signed record', {
      oxyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Background liveness probe for a single user's node. Fetches the node's
 * `/.well-known/oxy-node.json` over `safeFetch` (SSRF-safe) and updates the
 * cached badge: a 2xx → `active` + `lastSeenAt`; anything else (or a thrown
 * fetch error) → `unreachable` + `lastError`. Never throws and never reads more
 * than the response headers (the body is destroyed immediately). A `revoked`
 * node is skipped.
 */
export async function probeLiveness(oxyUserId: string): Promise<void> {
  try {
    const node = await MentionUserNode.findOne({ oxyUserId, status: { $ne: 'revoked' } })
      .select('endpoint')
      .lean<{ endpoint: string } | null>();
    if (!node) {
      return;
    }

    const probeAt = new Date();
    let update: UpdateQuery<IMentionUserNode>;

    try {
      const result = await safeFetch(wellKnownUrl(node.endpoint), {
        headersTimeoutMs: MENTION_NODE_PROBE_TIMEOUT_MS,
        maxRedirects: 1,
      });
      // Liveness only needs the status line — drop the body without reading it.
      result.response.destroy();

      if (result.status >= 200 && result.status < 300) {
        update = {
          $set: { status: 'active', lastSeenAt: probeAt, lastProbeAt: probeAt },
          $unset: { lastError: '' },
        };
      } else {
        update = {
          $set: {
            status: 'unreachable',
            lastProbeAt: probeAt,
            lastError: `node responded with HTTP ${result.status}`.slice(0, MENTION_NODE_LAST_ERROR_MAX_LEN),
          },
        };
      }
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      update = {
        $set: {
          status: 'unreachable',
          lastProbeAt: probeAt,
          lastError: message.slice(0, MENTION_NODE_LAST_ERROR_MAX_LEN),
        },
      };
      logger.debug('MentionNodeRegistry: node liveness probe failed', { oxyUserId, error: message });
    }

    await MentionUserNode.updateOne({ oxyUserId, status: { $ne: 'revoked' } }, update);
  } catch (err) {
    // A DB error during a background probe must never escape — log and move on.
    logger.error('MentionNodeRegistry: node liveness probe encountered an error', {
      oxyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Re-probe a bounded batch of registered nodes (least-recently-probed first).
 * Sequential to bound the outbound concurrency; each probe is independent and
 * non-throwing. Called ONLY by the leader-gated background scheduler.
 */
export async function sweepNodeLiveness(): Promise<void> {
  const nodes = await MentionUserNode.find({ status: { $in: ['active', 'unreachable'] } })
    .sort({ lastProbeAt: 1 })
    .limit(MENTION_NODE_LIVENESS_SWEEP_BATCH)
    .select('oxyUserId')
    .lean<Array<{ oxyUserId: string }>>();

  for (const node of nodes) {
    await probeLiveness(node.oxyUserId);
  }
}

/** The cached node row for a user (any status), or `null`. */
export async function getUserNode(oxyUserId: string): Promise<IMentionUserNode | null> {
  return MentionUserNode.findOne({ oxyUserId }).lean<IMentionUserNode | null>();
}

/**
 * Revoke a user's node registration (mark `revoked` so it leaves the liveness +
 * ingest sweeps). Returns `true` when a non-revoked row was flipped.
 *
 * Operator-agnostic: it revokes a self-hosted node and a MANAGED vault
 * identically — flipping `status` to `revoked` is the entire control-plane action.
 *
 * ## Managed-vault teardown seam (infra, out-of-band)
 *
 * For a managed vault (`managed:true, controller:'oxy'`) the underlying container
 * + on-disk storage are an INFRASTRUCTURE concern, not an API concern. Revoking
 * here is the durable, idempotent signal: a node-fleet reconciler tears down (or
 * archives) the per-user volume by reconciling against
 * `MentionUserNode.find({ managed: true, controller: 'oxy', status: 'revoked' })`.
 * The API never reaches the node inline (the read-path invariant), so this stays
 * a pure local DB write; the heavy teardown happens asynchronously in the fleet.
 */
export async function removeNode(oxyUserId: string): Promise<boolean> {
  const result = await MentionUserNode.updateOne(
    { oxyUserId, status: { $ne: 'revoked' } },
    { $set: { status: 'revoked' }, $unset: { lastError: '' } },
  );
  return result.modifiedCount > 0;
}

/* -------------------------------------------------------------------------- */
/*  Managed vault provisioning                                                */
/* -------------------------------------------------------------------------- */

/** Why {@link provisionManagedVault} could not provision a managed vault. */
export type ManagedVaultFailureReason =
  | 'custodial_key_unconfigured'
  | 'managed_endpoint_unconfigured'
  | 'provision_failed';

/** Result of {@link provisionManagedVault} — the active row, or a clear reason. */
export type ProvisionManagedVaultResult =
  | { ok: true; node: IMentionUserNode }
  | { ok: false; reason: ManagedVaultFailureReason };

/** The managed node's signing public key: a dedicated fleet key, else the custodial key. */
function resolveManagedNodePublicKey(): string | undefined {
  return process.env[MENTION_NODE_PUBLIC_KEY_ENV] || getMentionCustodialPublicKey() || undefined;
}

/**
 * Derive the managed-node endpoint for a user from `MENTION_NODE_BASE_URL`
 * (`${base}/u/${oxyUserId}`), validated/normalised as a credential-free HTTPS URL.
 * Returns `null` when the base is unset or not a usable HTTPS base — provisioning
 * then fails closed rather than registering a junk endpoint.
 */
function resolveManagedEndpoint(oxyUserId: string): string | null {
  const base = process.env[MENTION_NODE_BASE_URL_ENV];
  if (!base) {
    return null;
  }
  const trimmed = base.replace(/\/+$/, '');
  return normalizeHttpsEndpoint(`${trimmed}${MENTION_NODE_USER_PATH_PREFIX}${oxyUserId}`);
}

/**
 * Provision (or refresh) a Mention-operated MANAGED vault for `oxyUserId` — the
 * "Create your vault" convenience for non-technical users.
 *
 * Mention custodial-signs an `app.mention.node` record onto the user's hash chain
 * (issuer = `MENTION_DID`, signed by the Mention custodial key — the SAME
 * mechanism as the dual-write provenance record), runs it through the shared
 * {@link verifyAndStoreRecord} so it lands on the chain exactly like a self-signed
 * node record, then materializes the {@link MentionUserNode} cache as
 * `managed:true, controller:'oxy', status:'active'` and fires the async liveness
 * probe.
 *
 * Fails closed: with no Mention custodial key (`custodial_key_unconfigured`) or
 * no configured managed-node base URL (`managed_endpoint_unconfigured`) it
 * returns a clear error instead of creating a broken vault.
 *
 * Idempotent: re-provisioning while an active managed vault already exists at the
 * same endpoint is a no-op refresh (re-probe) — it does NOT append another chain
 * record. The container/storage orchestration itself is INFRA (a node-fleet
 * reconciler stands up the per-user volume off the active managed
 * {@link MentionUserNode} row — DEFERRED, exactly like Oxy F5c); this layer only
 * writes the cryptographic registration + the cache flag.
 */
export async function provisionManagedVault(oxyUserId: string): Promise<ProvisionManagedVaultResult> {
  const issuer = getMentionCustodialIssuer();
  const privateKey = getMentionCustodialPrivateKey();
  const custodialPublicKey = getMentionCustodialPublicKey();
  if (!issuer || !privateKey || !custodialPublicKey) {
    logger.warn('MentionNodeRegistry: managed vault refused — Mention custodial key not configured', {
      oxyUserId,
    });
    return { ok: false, reason: 'custodial_key_unconfigured' };
  }

  const endpoint = resolveManagedEndpoint(oxyUserId);
  if (!endpoint) {
    logger.warn('MentionNodeRegistry: managed vault refused — MENTION_NODE_BASE_URL unset or not a valid HTTPS base', {
      oxyUserId,
    });
    return { ok: false, reason: 'managed_endpoint_unconfigured' };
  }

  const nodePublicKey = resolveManagedNodePublicKey();
  if (!nodePublicKey) {
    // Unreachable while `custodialPublicKey` is set, but keeps the result total.
    return { ok: false, reason: 'custodial_key_unconfigured' };
  }

  // Idempotency: an already-active managed vault at this endpoint is a no-op
  // refresh — re-probe, but do NOT grow the chain.
  const existing = await getUserNode(oxyUserId);
  if (
    existing &&
    existing.managed === true &&
    existing.controller === 'oxy' &&
    existing.status !== 'revoked' &&
    existing.endpoint === endpoint
  ) {
    probeLiveness(oxyUserId).catch((err) =>
      logger.debug('MentionNodeRegistry: managed vault refresh probe failed to schedule', {
        oxyUserId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { ok: true, node: existing };
  }

  const subjectDid = buildUserDid(oxyUserId);
  const record: Record<string, unknown> = {
    endpoint,
    nodePublicKey,
    mode: MENTION_NODE_MANAGED_MODE,
    managed: true,
  };

  let stored = false;
  for (let attempt = 0; attempt < MAX_PROVISION_ATTEMPTS; attempt += 1) {
    const head = await getHead(oxyUserId);
    const seq = head ? head.seq + 1 : 0;
    const prev = head ? head.headRecordId : null;

    const fields: SignedRecordSigningFields = {
      version: 2,
      type: MENTION_RECORD_TYPE,
      subject: subjectDid,
      issuer,
      record,
      issuedAt: Date.now(),
      seq,
      prev,
      collection: MENTION_NODE_COLLECTION,
      rkey: MENTION_NODE_RKEY,
    };
    // Custodial-sign (issuer === MENTION_DID), then re-verify + store through the
    // SAME engine the dual-write uses. The resolver authorizes the custodial key.
    const envelope = await signEnvelope(fields, privateKey);
    const result = await verifyAndStoreRecord(envelope);
    if (result.ok) {
      stored = true;
      break;
    }

    // A concurrent writer advanced the chain head between our read and write —
    // re-read the head and retry. Anything else is a hard failure.
    if (result.reason === 'chain_conflict' || result.reason === 'bad_seq' || result.reason === 'chain_fork') {
      continue;
    }

    logger.warn('MentionNodeRegistry: managed vault node record rejected', {
      oxyUserId,
      reason: result.reason,
    });
    return { ok: false, reason: 'provision_failed' };
  }

  if (!stored) {
    logger.warn('MentionNodeRegistry: managed vault abandoned after chain-race retries', { oxyUserId });
    return { ok: false, reason: 'provision_failed' };
  }

  // Project the just-signed record into the operational cache as a
  // Mention-operated managed node (active) + fire the async liveness probe.
  const node = await materializeNodeFromRecord(oxyUserId, record, { managed: true, controller: 'oxy' });
  if (!node) {
    logger.error('MentionNodeRegistry: managed vault chain record stored but cache materialization failed', {
      oxyUserId,
    });
    return { ok: false, reason: 'provision_failed' };
  }

  return { ok: true, node };
}
