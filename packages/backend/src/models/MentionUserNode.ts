import mongoose, { Document, Schema } from 'mongoose';

/**
 * MentionUserNode (MTN Protocol — B3 user nodes / decentralization)
 *
 * Operational cache of a user's registered personal data node (a `mention-node`
 * — a DEPLOYMENT of `@oxyhq/node` with `appNamespace=app.mention`). The AUTHORITY
 * for a node registration is a signed `app.mention.node` record on the user's
 * hash chain (`collection: 'app.mention.node'`, `rkey: 'self'`, last-writer-wins)
 * — this row is a denormalised, fast-to-read projection of that record plus the
 * live liveness state Mention maintains in the background.
 *
 * This MIRRORS oxy-api's `UserNode` model, but it lives in MENTION's Mongo and is
 * keyed by `oxyUserId` (the user's Oxy account id as a STRING) instead of an Oxy
 * `userId` ObjectId — Mention has no `User` collection (exactly like
 * `MentionSignedRecord`). Identity/signing is Oxy's; the storage is Mention's.
 *
 * ## The read-path invariant
 *
 * Nothing in a request's READ path ever touches a node. A node being down means
 * this row is stale-but-instant, never slow. `status`/`lastSeenAt`/`lastError`/
 * `cursor` are updated ONLY by background liveness probes and the ingest/export
 * worker via `safeFetch` (SSRF-safe) — never inline in a request handler.
 *
 * One node per user (`oxyUserId` unique). Re-registration (a newer signed
 * `app.mention.node` record) upserts this row in place.
 */

/** How Mention and the node move records: the node pulls (default), or Mention pushes. */
export type MentionUserNodeMode = 'pull' | 'push';

/**
 * Who operates the node (managed vault):
 *  - `self` — the user self-hosts the node (the default; registered by a
 *    client-signed `app.mention.node` record the user published themselves).
 *  - `oxy`  — Mention operates the node ON BEHALF of a non-technical user, using
 *    the custodial key (`issuer = MENTION_DID`). Registered by a custodial-signed
 *    `app.mention.node` record via `provisionManagedVault`.
 */
export type MentionUserNodeController = 'self' | 'oxy';

/**
 * Liveness state of the node:
 *  - `active`      — last probe reached the node's `/.well-known/oxy-node.json`.
 *  - `unreachable` — last probe failed (DNS/connect/timeout/non-2xx). The row is
 *    still served from cache; only the badge changes.
 *  - `revoked`     — the user removed the node registration. Excluded from the
 *    liveness/ingest sweeps.
 */
export type MentionUserNodeStatus = 'active' | 'unreachable' | 'revoked';

export interface IMentionUserNode extends Document {
  /** The Oxy account id (string) that registered the node (one node per user). */
  oxyUserId: string;
  /** Optional DID the node advertises for itself (informational). */
  nodeDid?: string;
  /** The node's public HTTPS base URL (where its `/.well-known/oxy-node.json` lives). */
  endpoint: string;
  /** The node's secp256k1 public key (hex) — records it signs verify against this. */
  nodePublicKey: string;
  /** Transport direction. Defaults to `pull` (the node paces its own sync). */
  mode: MentionUserNodeMode;
  /**
   * Whether Mention operates this node on the user's behalf (managed vault) vs.
   * the user self-hosting it. A managed node is `managed:true, controller:'oxy'`,
   * registered by a custodial-signed `app.mention.node` record (issuer =
   * `MENTION_DID`).
   */
  managed: boolean;
  /**
   * Operator of the node — `self` (user self-hosts) or `oxy` (managed vault).
   * Defaults to `self`.
   */
  controller: MentionUserNodeController;
  /** Liveness badge — maintained only by background probes, never a read handler. */
  status: MentionUserNodeStatus;
  /** Last time a probe reached the node successfully. */
  lastSeenAt?: Date;
  /** Last time a probe ran (success or failure). */
  lastProbeAt?: Date;
  /** Human-readable reason the last probe OR ingest failed (cleared on success). */
  lastError?: string;
  /**
   * Last synced chain `seq` for the two-way sync — how far Mention has mirrored
   * the node's authentic chain back in (the `seq` of Mention's local chain head
   * after the last successful ingest). Advanced ONLY by the background worker.
   */
  cursor?: number;
  /**
   * Last time the ingest worker ran a pull for this node (success OR a caught-up
   * no-op). Maintained only in the background — never a read handler.
   */
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MentionUserNodeSchema = new Schema<IMentionUserNode>(
  {
    oxyUserId: { type: String, required: true, unique: true },
    nodeDid: { type: String },
    endpoint: { type: String, required: true },
    nodePublicKey: { type: String, required: true },
    mode: { type: String, enum: ['pull', 'push'], required: true, default: 'pull' },
    managed: { type: Boolean, required: true, default: false },
    controller: { type: String, enum: ['self', 'oxy'], required: true, default: 'self' },
    status: { type: String, enum: ['active', 'unreachable', 'revoked'], required: true, default: 'active' },
    lastSeenAt: { type: Date },
    lastProbeAt: { type: Date },
    lastError: { type: String },
    cursor: { type: Number },
    lastSyncedAt: { type: Date },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    strict: true,
    minimize: false,
  },
);

// Liveness/ingest sweeps scan by status (`active`/`unreachable`, never `revoked`).
MentionUserNodeSchema.index({ status: 1 });
// Ingest sweep picks the least-recently-synced `pull` nodes first.
MentionUserNodeSchema.index({ status: 1, mode: 1, lastSyncedAt: 1 });

export const MentionUserNode = mongoose.model<IMentionUserNode>('MentionUserNode', MentionUserNodeSchema);
export default MentionUserNode;
