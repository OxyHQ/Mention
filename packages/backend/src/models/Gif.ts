import mongoose, { Document, Schema } from 'mongoose';

/**
 * A GIF that Mention has fully IMPORTED into its own library — NOT a TTL cache
 * entry. The bytes (full mp4 + small mp4 preview) are copied into Oxy S3 once and
 * served from `cloud.oxy.so`, exactly like federated media is imported. The row is
 * the canonical, deduped index keyed by the provider id (`klipyId`): a GIF posted
 * by N users maps to ONE row and ONE pair of shared Oxy file ids.
 *
 * Search is local-first: the `$text` index over `searchTerms` + `title` answers
 * picker queries from our own data, and Klipy is only used to top up + import what
 * we do not yet own (see `services/gifLibrary`).
 */
export interface IGif extends Document {
  /** Provider id (Klipy's numeric id, stringified). Unique dedup key. */
  klipyId: string;
  /** Provider this GIF was imported from. Only Klipy today. */
  source: 'klipy';
  /** Provider slug (human-readable id fragment). */
  slug: string;
  /** Provider title / caption. */
  title: string;
  /**
   * Normalized search tokens that surfaced this GIF — the union of every query
   * term it was returned for plus tokens from its title/slug/tags. Drives the
   * `$text` index. Appended to (deduped) every time the GIF resurfaces.
   */
  searchTerms: string[];
  /** Intrinsic pixel width (provider-reported; falls back to a default). */
  width: number;
  /** Intrinsic pixel height (provider-reported; falls back to a default). */
  height: number;
  /** Oxy file id of the imported full mp4 — the SHARED source attached to posts. */
  mp4FileId: string;
  /** Oxy file id of the imported small mp4 preview — the picker grid tile. */
  previewFileId: string;
  /** Times this GIF has been posted (via `POST /gifs/use`). */
  useCount: number;
  /** Times this GIF has been surfaced in a search/trending result. */
  searchHitCount: number;
  /** Last time this GIF was posted. */
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const GifSchema = new Schema<IGif>(
  {
    klipyId: { type: String, required: true, unique: true },
    source: { type: String, required: true, enum: ['klipy'], default: 'klipy' },
    slug: { type: String, default: '' },
    title: { type: String, default: '' },
    searchTerms: { type: [String], default: [] },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    mp4FileId: { type: String, required: true },
    previewFileId: { type: String, required: true },
    useCount: { type: Number, required: true, default: 0 },
    searchHitCount: { type: Number, required: true, default: 0 },
    lastUsedAt: { type: Date, required: true, default: Date.now },
  },
  {
    collection: 'gifs',
    timestamps: true,
  },
);

// Local-first ranking helpers: most-posted / most-recently-used (trending + tie-break).
GifSchema.index({ useCount: -1 });
GifSchema.index({ lastUsedAt: -1 });

// Full-text search over the library.
//
// `language_override` intentionally points at the field `gifTextLanguage`, which
// NO document has. By default MongoDB's text index treats a per-document field
// literally named `language` as the stemmer language override, and rejects any
// unsupported ISO code with error 17262 ("language override unsupported") — the
// same gotcha that broke Post ingest. GIF search terms are multilingual provider
// tags, so the index is declared with `default_language: 'none'` (no stemming /
// stop-word stripping — `searchTerms` are pre-normalized in the service) and the
// override pinned to a non-existent field so the document `language` field, if it
// ever appears, can never poison the index.
GifSchema.index(
  { searchTerms: 'text', title: 'text' },
  {
    default_language: 'none',
    language_override: 'gifTextLanguage',
    name: 'gif_search_text',
    weights: { searchTerms: 5, title: 1 },
  },
);

export const Gif = mongoose.model<IGif>('Gif', GifSchema);

export default Gif;
