import mongoose, { Schema, Document } from 'mongoose';

/**
 * Provenance for a starter pack MIRRORED from an external network (atproto today).
 *
 * A pack carrying a `source` is OWNED UPSTREAM and read-only through Mention's
 * write API — its membership is a mirror of the remote list, re-synced in place on
 * every profile view, so a local edit would be silently overwritten on the next
 * sync and is therefore rejected (see `routes/starterPacks.ts`). `uri` is the
 * source pack's canonical identifier (the atproto starter-pack AT-URI) and the
 * dedup key for re-sync: a sparse UNIQUE index guarantees exactly one Mention pack
 * per remote pack (see migration `0006-federated-starter-pack-source-index`).
 */
export interface StarterPackSource {
  /** The external network this pack was imported from. */
  network: 'atproto';
  /** The source pack's canonical URI (e.g. `at://…/app.bsky.graph.starterpack/…`). */
  uri: string;
  /** When the pack was last mirrored from the source network. */
  syncedAt: Date;
}

/**
 * A pack's membership, with duplicates removed and first-occurrence order kept.
 *
 * ON THE MODEL, NOT IN A ROUTE, BECAUSE THE ROUTES ALREADY DISAGREED. Of the
 * three write paths, only `POST /:id/members` deduped (it unions into a `Set`);
 * `POST /` and `PUT /:id` stored whatever array the client sent. So the same pack
 * could be duplicate-free or not depending purely on which endpoint the UI
 * happened to use — and pack `6a35840f2160a431714b96d5` reached production with
 * seven entries for five accounts, the same id twice, twice over.
 *
 * A setter is the one place no future write path can go around: `create`,
 * `save`, and a direct assignment all pass through it. Note it does NOT cover
 * `$push`/`$addToSet` in a raw update — nothing does that today, and `$addToSet`
 * would be correct anyway.
 *
 * Order is preserved rather than sorted: the members list is rendered in stored
 * order and the owner chose it. Deduping must not silently reshuffle their pack.
 */
export function dedupeMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

export interface IStarterPack extends Document {
  ownerOxyUserId: string;
  name: string;
  description?: string;
  memberOxyUserIds: string[];
  usedByOxyUserIds: string[];
  useCount: number;
  /** Set only on packs mirrored from an external network — read-only, owned upstream. */
  source?: StarterPackSource;
  createdAt: Date;
  updatedAt: Date;
}

const StarterPackSourceSchema = new Schema<StarterPackSource>({
  network: { type: String, enum: ['atproto'], required: true },
  uri: { type: String, required: true },
  syncedAt: { type: Date, required: true },
}, { _id: false });

const StarterPackSchema = new Schema<IStarterPack>({
  ownerOxyUserId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  memberOxyUserIds: { type: [String], default: [], set: dedupeMemberIds },
  usedByOxyUserIds: { type: [String], default: [] },
  useCount: { type: Number, default: 0 },
  source: { type: StarterPackSourceSchema },
}, { timestamps: true });

StarterPackSchema.index({ ownerOxyUserId: 1, createdAt: -1 });
StarterPackSchema.index({ useCount: -1, createdAt: -1 });
/**
 * MULTIKEY index on the member array, compounded with `useCount`.
 *
 * Serves the starter-pack CURATION aggregation (`services/starterPackCuration.ts`),
 * which matches `{ memberOxyUserIds: { $in: [...] }, useCount: { $gte: n } }` to
 * find the packs that curate a batch of feed authors. `memberOxyUserIds` is the
 * only array field in the compound (a compound index may have at most one), so the
 * `$in` on the members is index-served and `useCount` filters within it.
 *
 * NOTE: `autoIndex`/`autoCreate` are OFF in production — this index is created by
 * migration `0005-starter-pack-member-index`, not on model load.
 */
StarterPackSchema.index({ memberOxyUserIds: 1, useCount: -1 });

/**
 * SPARSE UNIQUE index on the external-source URI.
 *
 * The single dedup key for external imports: a starter pack mirrored from atproto
 * is upserted on `source.uri`, so this index makes re-sync idempotent (one Mention
 * pack per remote pack) and closes the concurrent-import race (E11000). SPARSE so
 * it only covers packs that carry a `source` — native packs (the overwhelming
 * majority) have no `source` field and are excluded entirely, so their uniqueness
 * is unaffected.
 *
 * NOTE: `autoIndex`/`autoCreate` are OFF in production — this index is created by
 * migration `0006-federated-starter-pack-source-index`, not on model load.
 */
StarterPackSchema.index({ 'source.uri': 1 }, { unique: true, sparse: true });

export const StarterPack = mongoose.model<IStarterPack>('StarterPack', StarterPackSchema);
export default StarterPack;
