/**
 * Content-addressed blob reference for the atproto bridge view.
 *
 * MTN records reference media by `sha256` (a CONTENT address — the bytes live in
 * the Oxy File Manager / CDN, deduped by hash). atproto blobs are likewise
 * content-addressed (an IPLD CID over the bytes). The bridge therefore exposes
 * the `sha256` as the blob's content address directly.
 *
 * HONESTY / FLAGGED GAP: the canonical Oxy CDN (`cloud.oxy.so/<fileId>` →
 * `GET /cdn/:id`) resolves by Oxy FILE ID, not by `sha256` — and the MTN record
 * carries only the `sha256` (content-addressed by design, no fileId). There is no
 * by-`sha256` CDN route today and the SDK exposes only fileId→sha256
 * (`getServiceAssetMetadataByIds`), not the reverse. So the bridge CANNOT
 * fabricate a working `cloud.oxy.so` URL from a `sha256` alone. Rather than emit a
 * dead URL, {@link blobContentRef} returns the content address itself.
 *
 * Wiring a real renderable blob URL (a by-`sha256` CDN resolver, or a
 * `sha256 → fileId` reverse index) is part of the media/blob-layer unification
 * (Workstream B's blob path) and the CAR/MST sub-phase — flagged, not built here.
 */

/**
 * The content-addressed reference for a blob `sha256`. This is the IPLD-style
 * content link (`ipfs`-agnostic) the bridge surfaces; it is NOT a fetchable HTTP
 * URL (see the FLAGGED GAP above). Kept as a single chokepoint so a future
 * by-`sha256` CDN resolver swaps in here without touching the translator.
 */
export function blobContentRef(sha256: string): string {
  return sha256;
}
