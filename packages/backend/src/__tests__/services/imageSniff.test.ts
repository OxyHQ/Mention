import { describe, expect, it } from 'vitest';
import { isAnimatedImage, isWebSafeImageType, sniffImageMime } from '../../services/mediaCache/imageSniff';

/** The magic-byte decision a sniffing download (a federated banner) is made on. */
describe('sniffImageMime', () => {
  it.each([
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'],
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'image/png'],
    ['GIF', Buffer.from('GIF89a......'), 'image/gif'],
    ['WebP', Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
    ['AVIF', Buffer.from('\0\0\0\x1cftypavif'), 'image/avif'],
    ['HEIC', Buffer.from('\0\0\0\x18ftypheic'), 'image/heic'],
    ['BMP', Buffer.from('BM\0\0\0\0'), 'image/bmp'],
    ['TIFF', Buffer.from('II*\0\0\0'), 'image/tiff'],
  ])('recognises %s', (_name, bytes, mime) => {
    expect(sniffImageMime(bytes)).toBe(mime);
  });

  it.each([
    ['HTML', '<!doctype html><html></html>'],
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['XML-prefixed SVG', '<?xml version="1.0"?><svg></svg>'],
    ['JSON', '{"error":"not found"}'],
    ['MP4', '\0\0\0\x18ftypisom'],
    ['empty', ''],
  ])('refuses %s', (_name, text) => {
    expect(sniffImageMime(Buffer.from(text, 'latin1'))).toBeNull();
  });

  it('knows which formats render as-is', () => {
    expect(isWebSafeImageType('image/webp')).toBe(true);
    expect(isWebSafeImageType('image/heic')).toBe(false);
    expect(isWebSafeImageType('image/tiff')).toBe(false);
  });
});

describe('isAnimatedImage', () => {
  const gce = Buffer.from([0x21, 0xf9, 0x04]);

  it('a GIF with two frames is animated, one frame is not', () => {
    expect(isAnimatedImage(Buffer.concat([Buffer.from('GIF89a'), gce, Buffer.alloc(8), gce]), 'image/gif')).toBe(true);
    expect(isAnimatedImage(Buffer.concat([Buffer.from('GIF89a'), gce, Buffer.alloc(8)]), 'image/gif')).toBe(false);
  });

  it('a WebP with the VP8X animation flag is animated', () => {
    const header = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8X'), Buffer.from([0, 0, 0, 0, 0x02])]);
    expect(isAnimatedImage(header, 'image/webp')).toBe(true);
    header[20] = 0x00;
    expect(isAnimatedImage(header, 'image/webp')).toBe(false);
  });

  it('an APNG (acTL before IDAT) is animated, a plain PNG is not', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isAnimatedImage(Buffer.concat([png, Buffer.from('IHDRacTLIDAT')]), 'image/png')).toBe(true);
    expect(isAnimatedImage(Buffer.concat([png, Buffer.from('IHDRIDAT')]), 'image/png')).toBe(false);
  });
});
