/**
 * Mention user-node constants (MTN Protocol — B3 decentralization / personal
 * data nodes).
 *
 * SINGLE SOURCE OF TRUTH for the tunables of node registration, the liveness
 * probe, the background liveness sweep, and the node→Mention ingest. Nothing in
 * the node services may hardcode these — import them here. A faithful port of
 * oxy-api's `nodes.constants.ts`, scoped to the `app.mention.*` namespace (a
 * `mention-node` is a DEPLOYMENT of `@oxyhq/node` with `appNamespace=app.mention`).
 */

import { MENTION_FEED_COLLECTIONS, MENTION_BOOKMARK_COLLECTION } from '@mention/shared-types';

/**
 * AtProto-style collection (NSID) carried by a signed `app.mention.node` record.
 * The record's `rkey` is fixed to {@link MENTION_NODE_RKEY} so a user has exactly
 * ONE active node registration (last-writer-wins on the chain's
 * `(collection, rkey)` key).
 */
export const MENTION_NODE_COLLECTION = 'app.mention.node' as const;

/** The single record key for a user's node registration (one node per user). */
export const MENTION_NODE_RKEY = 'self' as const;

/**
 * The well-known liveness manifest a `mention-node` serves. The probe fetches
 * this over HTTPS via `safeFetch`; a 2xx means the node is reachable. Matches the
 * `@oxyhq/node` manifest path (the node base is app-agnostic).
 */
export const MENTION_NODE_WELL_KNOWN_PATH = '/.well-known/oxy-node.json' as const;

/** Time-to-first-byte deadline for a liveness probe (kept short — background). */
export const MENTION_NODE_PROBE_TIMEOUT_MS = 5_000;

/** Max length of a stored `lastError` string (keeps the row bounded). */
export const MENTION_NODE_LAST_ERROR_MAX_LEN = 300;

/** Max nodes re-probed per sweep (bounds the background work). */
export const MENTION_NODE_LIVENESS_SWEEP_BATCH = 100;

/**
 * Max liveness probes in flight at once during a sweep. Bounds the outbound
 * socket fan-out so one slow/offline node never stalls the rest (and we never
 * open all {@link MENTION_NODE_LIVENESS_SWEEP_BATCH} sockets simultaneously).
 */
export const MENTION_NODE_LIVENESS_PROBE_CONCURRENCY = 8;

/* -------------------------------------------------------------------------- */
/*  Bidirectional sync (node → Mention ingest)                                */
/* -------------------------------------------------------------------------- */

/** Records pulled per `/oxy/log` page (bounds a single fetch's working set). */
export const MENTION_NODE_INGEST_BATCH = 100;

/**
 * Hard cap on log pages processed in one `ingestFromNode` run. The batch × this
 * bounds how many records a single ingest can append (`100 × 50 = 5000`) so a
 * very long chain is caught up across several scheduled runs, never one
 * unbounded loop — the read hot path is NEVER contended by a backfill.
 */
export const MENTION_NODE_INGEST_MAX_ITERATIONS = 50;

/** Time-to-first-byte deadline for a node head/log fetch (kept short). */
export const MENTION_NODE_INGEST_FETCH_TIMEOUT_MS = 8_000;

/** Max bytes read from a single `/oxy/log` response before the stream is cut. */
export const MENTION_NODE_INGEST_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

/* -------------------------------------------------------------------------- */
/*  Node-blob mirror (content-addressed media bytes node → Oxy S3)            */
/* -------------------------------------------------------------------------- */

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Max media items per ingested post record we will attempt to mirror from the
 * node. Bounds the per-record fetch+upload work so a single hostile/oversized
 * record can never balloon a background ingest run. A normal post carries a
 * handful of media items; this is a generous ceiling.
 */
export const MENTION_NODE_BLOB_MIRROR_MAX_ITEMS = 8;

/**
 * Max bytes of a single blob we will pull from a node and mirror into Oxy S3.
 * Matches the federated media cache's video ceiling so node-sourced video is
 * treated identically to ActivityPub video. A blob whose advertised `size` (or
 * fetched byte length) exceeds this is skipped (left unresolvable → no media,
 * never a partial/oversized upload).
 */
export const MENTION_NODE_BLOB_MIRROR_MAX_BYTES = 200 * BYTES_PER_MIB;

/** Time-to-first-byte deadline for a single `getBlob` fetch from a node. */
export const MENTION_NODE_BLOB_FETCH_TIMEOUT_MS = 15_000;

/** Records pushed per export batch (bounds the outbound working set). */
export const MENTION_NODE_EXPORT_BATCH = 100;

/**
 * Hard cap on export pages pushed in one `exportToNode` run. Bounds how many
 * local records a single export pushes (`100 × 50 = 5000`) so a long backlog is
 * drained across several scheduled runs, never one unbounded loop.
 */
export const MENTION_NODE_EXPORT_MAX_ITERATIONS = 50;

/**
 * The PUBLIC collections a node log / export includes. Bookmarks
 * (`app.mention.feed.bookmark`) are PRIVATE — they are excluded so a public
 * export/ingest never leaks them. Derived from the canonical feed-collection set
 * minus the private bookmark collection, so a new public collection flows through
 * here automatically.
 */
export const MENTION_NODE_PUBLIC_COLLECTIONS: readonly string[] = MENTION_FEED_COLLECTIONS.filter(
  (collection) => collection !== MENTION_BOOKMARK_COLLECTION,
);

/* -------------------------------------------------------------------------- */
/*  Background sweep intervals                                                 */
/* -------------------------------------------------------------------------- */

/** How often the background sweep re-probes registered nodes (leader-gated). */
export const MENTION_NODE_LIVENESS_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** How often the background sweep pulls `mode:'pull'` active nodes (leader-gated). */
export const MENTION_NODE_INGEST_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Max active `pull` nodes ingested per sweep (bounds the background work). */
export const MENTION_NODE_INGEST_SWEEP_BATCH = 100;

/**
 * Delay after startup before the first liveness + ingest sweep ticks, so boot is
 * never contended by a backfill. The ingest sweep is offset after the liveness
 * sweep so the two never start in lockstep.
 */
export const MENTION_NODE_LIVENESS_SWEEP_START_DELAY_MS = 60 * 1000; // 1 minute
export const MENTION_NODE_INGEST_SWEEP_START_DELAY_MS = 90 * 1000; // 1.5 minutes

/* -------------------------------------------------------------------------- */
/*  Managed vault (Mention operates a node on behalf of a user)               */
/* -------------------------------------------------------------------------- */

/**
 * Env var naming the HTTPS base URL of the Mention-operated managed-node fleet. A
 * managed vault's endpoint is derived as
 * `${MENTION_NODE_BASE_URL}${MENTION_NODE_USER_PATH_PREFIX}${oxyUserId}` (e.g.
 * `https://nodes.mention.earth/u/<oxyUserId>`) — NEVER hardcoded. When unset (or
 * not a valid credential-free HTTPS base) managed-vault provisioning FAILS
 * CLOSED: a managed vault must have a real place to live, so Mention never
 * creates a broken one.
 */
export const MENTION_NODE_BASE_URL_ENV = 'MENTION_NODE_BASE_URL';

/** Per-user path segment appended under the managed-node base URL. */
export const MENTION_NODE_USER_PATH_PREFIX = '/u/';

/**
 * Env var optionally overriding the managed node's signing public key (hex
 * secp256k1). Mention operates a managed node with the CUSTODIAL key
 * (`controller:'oxy'`), so this DEFAULTS to `MENTION_PUBLIC_KEY` when unset —
 * records a managed node signs verify against the Mention custodial key exactly
 * like any other custodial (`issuer = MENTION_DID`) record. Set it only when the
 * managed fleet runs a dedicated keypair distinct from the custodial key.
 */
export const MENTION_NODE_PUBLIC_KEY_ENV = 'MENTION_NODE_PUBLIC_KEY';

/**
 * Transport mode for a managed vault. Mention operates both sides, but the node
 * still PULLS its own chain (the node paces sync) — identical to the self-hosted
 * default — so nothing in a read path ever waits on it.
 */
export const MENTION_NODE_MANAGED_MODE = 'pull' as const;
