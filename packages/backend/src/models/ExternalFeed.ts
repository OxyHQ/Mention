import mongoose, { Schema, Document } from 'mongoose';

/**
 * A READ-ONLY reference to an external network's feed GENERATOR (atproto today).
 *
 * A Bluesky feed (`app.bsky.feed.generator`) is a remote algorithmic service: its
 * `serviceDid` (a `did:web:` / `did:plc:` record) is the host that actually RUNS
 * the ranking algorithm. Mention CANNOT execute that algorithm, so — unlike
 * {@link ../models/CustomFeed} and {@link ../models/FeedGenerator}, which are
 * RUNNABLE Mention feeds the FeedEngine serves — this model is deliberately a
 * plain metadata record with NO runnable definition and NO coupling to the feed
 * engine. It exists only so a synced Bluesky profile can surface "feeds created by
 * this user" as reference cards that DEEP-LINK to Bluesky (`webUrl`).
 *
 * Provenance/dedup: `uri` is the feed generator's canonical AT-URI and the unique
 * upsert key, so re-sync mirrors the current metadata in place (one row per remote
 * feed). Owned by `ownerOxyUserId` (the resolved federated Oxy user who created
 * the feed) so a profile "feeds" surface can list them by owner.
 *
 * NOTE: `autoIndex`/`autoCreate` are OFF in production — the indexes below are
 * created by migration `0006-federated-starter-pack-source-index`, not on load.
 */
export interface IExternalFeed extends Document {
  /** The external network this feed reference was imported from. */
  network: 'atproto';
  /** The feed generator's canonical URI (`at://…/app.bsky.feed.generator/…`) — unique. */
  uri: string;
  /** The resolved federated Oxy user who created the feed (the profile owner). */
  ownerOxyUserId: string;
  /**
   * The DID of the remote service that RUNS the algorithm (`did:web:…`). Stored for
   * provenance only — Mention never dereferences or executes it.
   */
  serviceDid: string;
  /** The feed's display name. */
  name: string;
  description?: string;
  /** Remote (bsky CDN) avatar URL — a link-card thumbnail, not an Oxy-owned asset. */
  avatar?: string;
  /** The feed's like count on the source network (display only). */
  likeCount: number;
  /** Canonical web URL to open the feed on the source network. */
  webUrl: string;
  /** When this reference was last mirrored from the source network. */
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ExternalFeedSchema = new Schema<IExternalFeed>({
  network: { type: String, enum: ['atproto'], required: true },
  uri: { type: String, required: true },
  ownerOxyUserId: { type: String, required: true },
  serviceDid: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String },
  avatar: { type: String },
  likeCount: { type: Number, default: 0 },
  webUrl: { type: String, required: true },
  syncedAt: { type: Date, required: true },
}, { timestamps: true });

// Unique upsert/dedup key — one row per remote feed generator.
ExternalFeedSchema.index({ uri: 1 }, { unique: true });
// Owner lookup for a profile "feeds created by this user" surface.
ExternalFeedSchema.index({ ownerOxyUserId: 1, createdAt: -1 });

export const ExternalFeed = mongoose.model<IExternalFeed>('ExternalFeed', ExternalFeedSchema);
export default ExternalFeed;
