/**
 * Atproto BE-DISCOVERED bridge routes (Phase C4).
 *
 * The read XRPC surface that exposes a local Mention user's MTN content to the
 * atproto network, plus the handle→DID resolution a foreign AppView needs. All
 * routes are PUBLIC (no auth — atproto repo reads are public) and gated behind
 * {@link ATPROTO_BRIDGE_ENABLED}; when the bridge is off every route 404s.
 *
 * Mounted at `/xrpc` (the XRPC namespace) plus a `.well-known/atproto-did` route
 * mounted under `/.well-known`. The repo is addressed by a DID (the user's Oxy
 * `did:web`) on the sync/repo endpoints, exactly like a real PDS.
 *
 * SCOPE (honest): this serves the `listRecords` / `getRecord` / `describeRepo` /
 * `getLatestCommit` READ paths off the MTN chain. `com.atproto.sync.getRepo`
 * (full signed-MST CAR export) returns a structured `NotImplemented` — real CAR /
 * commit signing / the `subscribeRepos` firehose are the FLAGGED next sub-phase,
 * not a fake CAR.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { RedisStore } from '../../../middleware/rateLimitStore';
import { logger } from '../../../utils/logger';
import { parseUserDid } from '../../../services/mtn/mentionDid';
import { getHead } from '../../../services/mtn/MentionRepoLogService';
import { ANY_DID_RE } from '../constants';
import {
  ATPROTO_BRIDGE_ENABLED,
  BRIDGE_BSKY_COLLECTIONS,
  type BridgeBskyCollection,
} from './constants';
import {
  listRecords,
  getRecord,
  BRIDGE_DESCRIBE_COLLECTIONS,
} from './repoReadService';
import {
  getAtprotoIdentity,
  buildBridgeDidDocumentView,
  bridgePdsEndpoint,
} from './identityService';
import { resolveOxyUser } from '../../activitypub/constants';

const router = Router();

// Rate-limit the bridge read surface (300 req/min per IP — same band as the AP
// protocol endpoints; these are public, cacheable reads).
const bridgeRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:atbridge:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded' },
});
router.use(bridgeRateLimiter);

/** Gate: every bridge route 404s when the bridge is disabled. */
router.use((_req: Request, res: Response, next) => {
  if (!ATPROTO_BRIDGE_ENABLED) {
    res.status(404).json({ error: 'NotFound', message: 'atproto bridge disabled' });
    return;
  }
  next();
});

/** XRPC error envelope (atproto convention: `{ error, message }`). */
function xrpcError(res: Response, status: number, error: string, message: string): Response {
  return res.status(status).json({ error, message });
}

/** True when `value` is one of the served `app.bsky.*` collections. */
function isBridgeCollection(value: string): value is BridgeBskyCollection {
  return (BRIDGE_BSKY_COLLECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve the `repo` parameter (a DID or a local handle) to the owning Oxy user
 * id. A bridge repo is addressed by the user's Oxy `did:web`; a handle
 * (`<username>.<bridge domain>` or a bare username) is also accepted. Returns
 * null when it cannot be resolved to a local user.
 */
async function resolveRepoOwner(repo: string): Promise<string | null> {
  // DID form: parse the canonical Oxy user DID directly (no network).
  if (ANY_DID_RE.test(repo)) {
    return parseUserDid(repo);
  }
  // Handle form: strip a trailing bridge-domain suffix to the bare username, then
  // resolve via Oxy.
  const username = repo.includes('.') ? repo.split('.')[0] : repo;
  const user = await resolveOxyUser(username);
  return user?.id ? String(user.id) : null;
}

const listRecordsQuery = z.object({
  repo: z.string().min(1).max(2048),
  collection: z.string().min(1).max(256),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).max(256).optional(),
});

/**
 * GET /xrpc/com.atproto.repo.listRecords
 * Paginated list of a repo's records in a collection, newest-first, translated
 * from MTN to `app.bsky.feed.*`.
 */
router.get('/com.atproto.repo.listRecords', async (req: Request, res: Response) => {
  const parsed = listRecordsQuery.safeParse(req.query);
  if (!parsed.success) {
    return xrpcError(res, 400, 'InvalidRequest', parsed.error.issues[0].message);
  }
  const { repo, collection, limit, cursor } = parsed.data;
  if (!isBridgeCollection(collection)) {
    // A collection the bridge does not serve → empty page (a valid atproto answer).
    return res.json({ records: [] });
  }

  try {
    const oxyUserId = await resolveRepoOwner(repo);
    if (!oxyUserId) return xrpcError(res, 404, 'RepoNotFound', 'repo not found');

    const page = await listRecords(oxyUserId, collection, { limit, cursor });
    res.set('Cache-Control', 'public, max-age=30');
    return res.json({
      records: page.records.map((record) => ({ uri: record.uri, cid: record.cid, value: record.value })),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    });
  } catch (err) {
    logger.error('[atproto-bridge] listRecords failed', err);
    return xrpcError(res, 500, 'InternalServerError', 'failed to list records');
  }
});

const getRecordQuery = z.object({
  repo: z.string().min(1).max(2048),
  collection: z.string().min(1).max(256),
  rkey: z.string().min(1).max(512),
});

/**
 * GET /xrpc/com.atproto.repo.getRecord
 * Resolve a single record by `(repo, collection, rkey)`.
 */
router.get('/com.atproto.repo.getRecord', async (req: Request, res: Response) => {
  const parsed = getRecordQuery.safeParse(req.query);
  if (!parsed.success) {
    return xrpcError(res, 400, 'InvalidRequest', parsed.error.issues[0].message);
  }
  const { repo, collection, rkey } = parsed.data;
  if (!isBridgeCollection(collection)) {
    return xrpcError(res, 404, 'RecordNotFound', 'record not found');
  }

  try {
    const oxyUserId = await resolveRepoOwner(repo);
    if (!oxyUserId) return xrpcError(res, 404, 'RepoNotFound', 'repo not found');

    const record = await getRecord(oxyUserId, collection, rkey);
    if (!record) return xrpcError(res, 404, 'RecordNotFound', 'record not found');

    res.set('Cache-Control', 'public, max-age=30');
    return res.json({ uri: record.uri, cid: record.cid, value: record.value });
  } catch (err) {
    logger.error('[atproto-bridge] getRecord failed', err);
    return xrpcError(res, 500, 'InternalServerError', 'failed to get record');
  }
});

const repoQuery = z.object({ repo: z.string().min(1).max(2048) });

/**
 * GET /xrpc/com.atproto.repo.describeRepo
 * Describe a repo: its DID, handle, and the collections it hosts.
 */
router.get('/com.atproto.repo.describeRepo', async (req: Request, res: Response) => {
  const parsed = repoQuery.safeParse(req.query);
  if (!parsed.success) {
    return xrpcError(res, 400, 'InvalidRequest', parsed.error.issues[0].message);
  }

  try {
    const oxyUserId = await resolveRepoOwner(parsed.data.repo);
    if (!oxyUserId) return xrpcError(res, 404, 'RepoNotFound', 'repo not found');

    // The repo param may be a DID or a handle; re-resolve the canonical identity
    // facts by username so the response always carries the bridge handle + DID.
    const username = parsed.data.repo.includes('.') ? parsed.data.repo.split('.')[0] : parsed.data.repo;
    const identity = await getAtprotoIdentity(username);

    res.set('Cache-Control', 'public, max-age=60');
    return res.json({
      did: identity?.did ?? `did:web:placeholder`,
      handle: identity?.handle ?? username,
      collections: BRIDGE_DESCRIBE_COLLECTIONS,
      handleIsCorrect: Boolean(identity),
    });
  } catch (err) {
    logger.error('[atproto-bridge] describeRepo failed', err);
    return xrpcError(res, 500, 'InternalServerError', 'failed to describe repo');
  }
});

const didQuery = z.object({ did: z.string().min(1).max(2048) });

/**
 * GET /xrpc/com.atproto.sync.getLatestCommit
 * The repo's latest commit pointer. The MTN chain has no signed MST commit, so
 * the bridge reports the chain head: `rev` = the head `seq`, `cid` = the head
 * record's content address (placeholder CID). A genuine signed commit/`rev` is
 * the FLAGGED CAR/commit-signing sub-phase.
 */
router.get('/com.atproto.sync.getLatestCommit', async (req: Request, res: Response) => {
  const parsed = didQuery.safeParse(req.query);
  if (!parsed.success) {
    return xrpcError(res, 400, 'InvalidRequest', parsed.error.issues[0].message);
  }

  const oxyUserId = parseUserDid(parsed.data.did);
  if (!oxyUserId) return xrpcError(res, 400, 'InvalidRequest', 'did is not a bridge repo did');

  try {
    const head = await getHead(oxyUserId);
    if (!head) return xrpcError(res, 404, 'RepoNotFound', 'repo has no commits');

    res.set('Cache-Control', 'public, max-age=15');
    return res.json({
      cid: `mtn-${head.headRecordId}`,
      rev: String(head.seq),
    });
  } catch (err) {
    logger.error('[atproto-bridge] getLatestCommit failed', err);
    return xrpcError(res, 500, 'InternalServerError', 'failed to get latest commit');
  }
});

/**
 * GET /xrpc/com.atproto.sync.getRepo
 * Full repo CAR export. NOT IMPLEMENTED in this sub-phase — signed-MST CAR +
 * commit signing is the flagged next step. Returns a structured `NotImplemented`
 * (NOT a fake/empty CAR) so a caller fails clearly and falls back to the
 * record-level read endpoints.
 */
router.get('/com.atproto.sync.getRepo', (_req: Request, res: Response) => {
  return xrpcError(
    res,
    501,
    'NotImplemented',
    'CAR repo export is not yet available; use com.atproto.repo.listRecords',
  );
});

/**
 * GET /.well-known/atproto-did  (mounted at the `.well-known` level — see
 * `wellKnownBridgeRouter`). Resolves the requesting host's handle to the user's
 * Oxy DID. The handle is taken from the `Host` header (`<username>.<bridge
 * domain>`) so a foreign AppView doing handle resolution against
 * `https://<username>.<bridge domain>/.well-known/atproto-did` gets the DID.
 */
async function atprotoDidHandler(req: Request, res: Response): Promise<Response> {
  // The handle is the request host; the username is its first label.
  const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host || '';
  const username = host.split(':')[0]?.split('.')[0] ?? '';
  if (!username) return xrpcError(res, 400, 'InvalidRequest', 'no handle host');

  try {
    const identity = await getAtprotoIdentity(username);
    if (!identity) return xrpcError(res, 404, 'NotFound', 'handle not found');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(identity.did);
  } catch (err) {
    logger.error('[atproto-bridge] atproto-did resolution failed', err);
    return xrpcError(res, 500, 'InternalServerError', 'failed to resolve handle');
  }
}

/**
 * The bridge META router, mounted under `/ap-bridge` (the XRPC router is mounted
 * under `/xrpc`). Carries the non-XRPC bridge endpoints: the atproto-flavoured
 * DID-document VIEW and a health probe. Gated by the same bridge flag.
 */
export const bridgeMetaRouter = Router();
bridgeMetaRouter.use(bridgeRateLimiter);
bridgeMetaRouter.use((_req: Request, res: Response, next) => {
  if (!ATPROTO_BRIDGE_ENABLED) {
    res.status(404).json({ error: 'NotFound', message: 'atproto bridge disabled' });
    return;
  }
  next();
});

/**
 * GET /ap-bridge/did/:username — the atproto-flavoured DID document VIEW for a
 * local user (the canonical Oxy DID doc augmented with the `#atproto_pds`
 * service). Served by the BRIDGE for tooling; NOT a replacement for the canonical
 * `oxy.so` `did.json` (see `identityService` — the oxy-api seam is flagged).
 */
bridgeMetaRouter.get('/did/:username', async (req: Request, res: Response) => {
  const username = String(req.params.username || '').replace(/^@/, '');
  if (!username) return xrpcError(res, 400, 'InvalidRequest', 'username required');

  try {
    const doc = await buildBridgeDidDocumentView(username);
    if (!doc) return xrpcError(res, 404, 'NotFound', 'user not found');
    res.set('Content-Type', 'application/did+ld+json');
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(doc);
  } catch (err) {
    logger.error('[atproto-bridge] did document view failed', err);
    return xrpcError(res, 500, 'InternalServerError', 'failed to build did document');
  }
});

/**
 * GET /ap-bridge/health — a tiny readiness signal that the bridge is mounted +
 * which PDS endpoint it advertises (operator diagnostics only).
 */
bridgeMetaRouter.get('/health', (_req: Request, res: Response) => {
  return res.json({ ok: true, pds: bridgePdsEndpoint() });
});

/**
 * The `.well-known/atproto-did` router, mounted separately under `/.well-known`
 * (the XRPC router is mounted under `/xrpc`). Gated by the same bridge flag.
 */
export const wellKnownBridgeRouter = Router();
wellKnownBridgeRouter.get('/atproto-did', (req: Request, res: Response, next) => {
  if (!ATPROTO_BRIDGE_ENABLED) return next();
  void atprotoDidHandler(req, res);
});

export default router;
