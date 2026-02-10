import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger';

const DO_SPACES_KEY = process.env.DO_SPACES_KEY || '';
const DO_SPACES_SECRET = process.env.DO_SPACES_SECRET || '';
const DO_SPACES_REGION = process.env.DO_SPACES_REGION || 'nyc3';
const DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET || 'mention-recordings';
const DO_SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT || `https://${DO_SPACES_REGION}.digitaloceanspaces.com`;

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: DO_SPACES_ENDPOINT,
      region: DO_SPACES_REGION,
      credentials: {
        accessKeyId: DO_SPACES_KEY,
        secretAccessKey: DO_SPACES_SECRET,
      },
      forcePathStyle: false,
    });
  }
  return s3Client;
}

export function getBucket(): string {
  return DO_SPACES_BUCKET;
}

/**
 * Generate the S3 object key for a recording file.
 */
export function getRecordingObjectKey(roomId: string, recordingId: string): string {
  return `recordings/${roomId}/${recordingId}.ogg`;
}

/**
 * Generate a presigned URL for downloading/streaming a recording.
 */
export async function getRecordingPresignedUrl(
  objectKey: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: DO_SPACES_BUCKET,
    Key: objectKey,
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
}

/**
 * Delete a recording file from Spaces.
 */
export async function deleteRecordingFromSpaces(objectKey: string): Promise<void> {
  try {
    await getS3Client().send(new DeleteObjectCommand({
      Bucket: DO_SPACES_BUCKET,
      Key: objectKey,
    }));
    logger.info(`Deleted recording from Spaces: ${objectKey}`);
  } catch (error) {
    logger.error(`Failed to delete recording from Spaces: ${objectKey}`, error);
    throw error;
  }
}

/**
 * Build the S3 upload config for LiveKit Egress.
 */
export function getS3UploadConfig(objectKey: string) {
  return {
    accessKey: DO_SPACES_KEY,
    secret: DO_SPACES_SECRET,
    bucket: DO_SPACES_BUCKET,
    region: DO_SPACES_REGION,
    endpoint: DO_SPACES_ENDPOINT,
    filepath: objectKey,
    forcePathStyle: false,
  };
}
