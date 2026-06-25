export const DEFAULT_MAX_INPUT_IMAGE_WIDTH = 16_000;
export const DEFAULT_MAX_INPUT_IMAGE_HEIGHT = 16_000;
export const DEFAULT_MAX_INPUT_IMAGE_PIXELS = 50_000_000;

export const MAX_INPUT_IMAGE_WIDTH = Number(
  process.env.MAX_INPUT_IMAGE_WIDTH ?? DEFAULT_MAX_INPUT_IMAGE_WIDTH,
);
export const MAX_INPUT_IMAGE_HEIGHT = Number(
  process.env.MAX_INPUT_IMAGE_HEIGHT ?? DEFAULT_MAX_INPUT_IMAGE_HEIGHT,
);
export const MAX_INPUT_IMAGE_PIXELS = Number(
  process.env.MAX_INPUT_IMAGE_PIXELS ?? DEFAULT_MAX_INPUT_IMAGE_PIXELS,
);

export interface ImageDimensions {
  width?: number | null;
  height?: number | null;
}

export class InputImageTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputImageTooLargeError';
  }
}

function isValidDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function assertSafeInputImageDimensions(
  dimensions: ImageDimensions,
  limits = {
    maxWidth: MAX_INPUT_IMAGE_WIDTH,
    maxHeight: MAX_INPUT_IMAGE_HEIGHT,
    maxPixels: MAX_INPUT_IMAGE_PIXELS,
  },
): void {
  const { width, height } = dimensions;

  if (!isValidDimension(width) || !isValidDimension(height)) {
    throw new InputImageTooLargeError('Unable to determine input image dimensions');
  }

  if (width > limits.maxWidth || height > limits.maxHeight) {
    throw new InputImageTooLargeError(
      `Input image dimensions exceed limit (${width}x${height}; max ${limits.maxWidth}x${limits.maxHeight})`,
    );
  }

  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
    throw new InputImageTooLargeError(
      `Input image pixel count exceeds limit (${pixels}; max ${limits.maxPixels})`,
    );
  }
}

export function readInputImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length >= 24 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (buffer.length >= 10 &&
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      offset += 2;

      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }

      if (offset + 2 > buffer.length) {
        return null;
      }

      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) {
        return null;
      }

      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }

      offset += segmentLength;
    }
  }

  return null;
}

export function assertSafeInputImageBuffer(buffer: Buffer): void {
  const dimensions = readInputImageDimensions(buffer);
  if (dimensions) {
    assertSafeInputImageDimensions(dimensions);
  }
}

export function isInputImageTooLargeError(error: unknown): error is InputImageTooLargeError {
  return error instanceof InputImageTooLargeError;
}
