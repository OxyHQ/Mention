import sharp from 'sharp';

type ImagePreset = 'avatar' | 'cover' | 'roomImage';

const PRESETS: Record<ImagePreset, { width: number; height: number; quality: number }> = {
  avatar: { width: 400, height: 400, quality: 80 },
  cover: { width: 1200, height: 630, quality: 85 },
  roomImage: { width: 800, height: 450, quality: 80 },
};

export async function processImage(
  input: Buffer,
  preset: ImagePreset,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { width, height, quality } = PRESETS[preset];
  const buffer = await sharp(input)
    .resize(width, height, { fit: 'cover' })
    .webp({ quality })
    .toBuffer();
  return { buffer, contentType: 'image/webp' };
}
