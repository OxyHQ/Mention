/**
 * What a downloaded image IS, decided from its bytes.
 *
 * Remote hosts routinely mislabel real pictures (`text/plain`,
 * `binary/octet-stream`, even `text/html` from some CDNs), and a lying host can
 * label an HTML page `image/jpeg`. So for a download whose contract is "a
 * picture" (a federated banner), the declared Content-Type is never trusted —
 * the magic bytes are. The same approach as oxy-api's federated avatars
 * (`services/federation/avatarImage.ts`, OxyHQServices #1452).
 *
 * SVG is deliberately NOT recognised: it is a document that can carry script,
 * not a picture, and a banner is served from a public CDN origin. HTML, XML and
 * anything else without a raster signature sniff as `null` and are refused.
 */

/** How many leading bytes {@link sniffImageMime} and {@link isAnimatedImage} need at most. */
export const IMAGE_SNIFF_BYTES = 64 * 1024;

/** Raster formats every client renders as-is. */
const WEB_SAFE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString('latin1');
}

/** The raster image type the bytes declare, or `null` when they are not one. */
export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (buffer.length >= 6 && (ascii(buffer, 0, 6) === 'GIF87a' || ascii(buffer, 0, 6) === 'GIF89a'))
    return 'image/gif';
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP')
    return 'image/webp';
  if (buffer.length >= 12 && ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  if (buffer.length >= 2 && ascii(buffer, 0, 2) === 'BM') return 'image/bmp';
  if (buffer.length >= 4 && (ascii(buffer, 0, 4) === 'II*\0' || ascii(buffer, 0, 4) === 'MM\0*'))
    return 'image/tiff';
  return null;
}

/** True for a type every client renders as-is (no re-encode needed for the FORMAT). */
export function isWebSafeImageType(mime: string): boolean {
  return WEB_SAFE_IMAGE_TYPES.has(mime);
}

/**
 * True when the leading bytes show an ANIMATED image: an animated WebP (the
 * VP8X animation flag), an APNG (an `acTL` chunk before the first `IDAT`), or a
 * GIF with more than one frame (a second Graphic Control Extension within the
 * sniffed prefix). A banner is a still header image, so an animated one is
 * stored as its first frame.
 */
export function isAnimatedImage(buffer: Buffer, mime: string): boolean {
  if (mime === 'image/webp') {
    // RIFF....WEBPVP8X, then a flags byte: bit 1 (0x02) is "animation".
    return buffer.length >= 21 && ascii(buffer, 12, 16) === 'VP8X' && (buffer[20] & 0x02) !== 0;
  }
  if (mime === 'image/png') {
    const acTL = buffer.indexOf('acTL', 8, 'latin1');
    const idat = buffer.indexOf('IDAT', 8, 'latin1');
    return acTL !== -1 && (idat === -1 || acTL < idat);
  }
  if (mime === 'image/gif') {
    // Graphic Control Extension: 0x21 0xF9 0x04. One per frame in practice.
    const marker = Buffer.from([0x21, 0xf9, 0x04]);
    const first = buffer.indexOf(marker);
    return first !== -1 && buffer.indexOf(marker, first + marker.length) !== -1;
  }
  return false;
}
