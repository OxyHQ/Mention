/**
 * FeedGenerator Model
 *
 * A third-party / algorithmic feed the Mention feed engine can SERVE via the
 * `feedgen|<uri>` descriptor (see `mtn/feed/feeds/FeedGeneratorFeed.ts`). Unlike a
 * `CustomFeed` (a Mention-native user curation), a FeedGenerator's content is
 * produced by a remote ranking algorithm; Mention pulls that ranking live and
 * imports the results as native `Post` rows.
 *
 * The only producer today is the atproto connector, which mirrors a Bluesky feed
 * generator (`app.bsky.feed.generator`) into a FeedGenerator keyed on the source
 * AT-URI (`uri`). Such a record carries a `source` — it is OWNED UPSTREAM and
 * re-synced in place on every profile view, so it is read-only through any Mention
 * write API (guard a future mutation route on `source` exactly as
 * `routes/starterPacks.ts` guards a mirrored pack's `source`).
 */

import mongoose, { Schema, Document } from 'mongoose';

/**
 * Provenance for a FeedGenerator MIRRORED from an external network (atproto today).
 * Present only on records pulled from a remote generator; native FeedGenerators
 * (none exist yet) omit it. `source.network === 'atproto'` is the authoritative
 * "this generator's content comes from a remote atproto feed at `uri`" marker the
 * `FeedGeneratorFeed` reads before dereferencing the remote feed.
 */
export interface FeedGeneratorSource {
  /** The external network this generator was imported from. */
  network: 'atproto';
  /** The DID of the remote service that RUNS the ranking algorithm (`did:web:…`). */
  serviceDid: string;
  /** When the generator's metadata was last mirrored from the source network. */
  syncedAt: Date;
}

export interface IFeedGenerator extends Document {
  uri: string;
  name: string;
  description?: string;
  avatar?: string;
  algorithm: string;
  createdBy: string;
  likeCount: number;
  subscriberCount: number;
  /** Set only on generators mirrored from an external network — read-only, owned upstream. */
  source?: FeedGeneratorSource;
  createdAt: Date;
  updatedAt: Date;
}

const feedGeneratorSourceSchema = new Schema<FeedGeneratorSource>(
  {
    network: { type: String, enum: ['atproto'], required: true },
    serviceDid: { type: String, required: true },
    syncedAt: { type: Date, required: true },
  },
  { _id: false },
);

const feedGeneratorSchema = new Schema<IFeedGenerator>(
  {
    uri: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, maxlength: 64 },
    description: { type: String, maxlength: 300 },
    avatar: { type: String },
    algorithm: { type: String, required: true },
    createdBy: { type: String, required: true, index: true },
    likeCount: { type: Number, default: 0 },
    subscriberCount: { type: Number, default: 0 },
    source: { type: feedGeneratorSourceSchema },
  },
  { timestamps: true }
);

export const FeedGenerator = mongoose.model<IFeedGenerator>('FeedGenerator', feedGeneratorSchema);
