import { describe, expect, it } from 'vitest';
import {
  InputImageTooLargeError,
  assertSafeInputImageBuffer,
  assertSafeInputImageDimensions,
  readInputImageDimensions,
} from '../../utils/imageDimensionGuard';

function makePngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt8(0x89, 0);
  buffer.write('PNG', 1, 'ascii');
  buffer.writeUInt8(0x0d, 4);
  buffer.writeUInt8(0x0a, 5);
  buffer.writeUInt8(0x1a, 6);
  buffer.writeUInt8(0x0a, 7);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('assertSafeInputImageDimensions', () => {
  it('accepts images within dimension and pixel limits', () => {
    expect(() =>
      assertSafeInputImageDimensions(
        { width: 1200, height: 800 },
        { maxWidth: 1600, maxHeight: 1200, maxPixels: 2_000_000 },
      ),
    ).not.toThrow();
  });

  it('rejects images above the maximum width or height', () => {
    expect(() =>
      assertSafeInputImageDimensions(
        { width: 20_000, height: 100 },
        { maxWidth: 16_000, maxHeight: 16_000, maxPixels: 50_000_000 },
      ),
    ).toThrow(InputImageTooLargeError);
  });

  it('rejects compressed pixel bombs that fit byte limits but exceed pixel limits', () => {
    expect(() =>
      assertSafeInputImageDimensions(
        { width: 10_000, height: 10_000 },
        { maxWidth: 16_000, maxHeight: 16_000, maxPixels: 50_000_000 },
      ),
    ).toThrow(InputImageTooLargeError);
  });
});

describe('readInputImageDimensions', () => {
  it('reads PNG dimensions without decoding the image payload', () => {
    expect(readInputImageDimensions(makePngHeader(20_000, 20_000))).toEqual({
      width: 20_000,
      height: 20_000,
    });
  });

  it('rejects an over-limit PNG before native image processing', () => {
    expect(() => assertSafeInputImageBuffer(makePngHeader(20_000, 20_000))).toThrow(
      InputImageTooLargeError,
    );
  });
});
