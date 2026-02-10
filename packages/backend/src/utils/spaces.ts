import { S3Client, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger';

const DO_SPACES_KEY = process.env.DO_SPACES_KEY || '';
const DO_SPACES_SECRET = process.env.DO_SPACES_SECRET || '';
const DO_SPACES_REGION = process.env.DO_SPACES_REGION || 'ams3';
const DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET || 'mention-bucket';
const DO_SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT || `https://${DO_SPACES_REGION}.digitaloceanspaces.com`;
const DO_SPACES_CDN_ENDPOINT = process.env.DO_SPACES_CDN_ENDPOINT || `https://${DO_SPACES_BUCKET}.${DO_SPACES_REGION}.cdn.digitaloceanspaces.com`;

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

export function getCdnUrl(objectKey: string): string {
  return `${DO_SPACES_CDN_ENDPOINT}/${objectKey}`;
}

// ---------------------------------------------------------------------------
// Generic S3 operations
// ---------------------------------------------------------------------------

export async function getPresignedUrl(
  objectKey: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: DO_SPACES_BUCKET,
    Key: objectKey,
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
}

export async function getPresignedUploadUrl(
  objectKey: string,
  contentType: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: DO_SPACES_BUCKET,
    Key: objectKey,
    ContentType: contentType,
    ACL: 'private',
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
}

export async function deleteObject(objectKey: string): Promise<void> {
  try {
    await getS3Client().send(new DeleteObjectCommand({
      Bucket: DO_SPACES_BUCKET,
      Key: objectKey,
    }));
    logger.info(`Deleted from Spaces: ${objectKey}`);
  } catch (error) {
    logger.error(`Failed to delete from Spaces: ${objectKey}`, error);
    throw error;
  }
}

export async function uploadObject(
  objectKey: string,
  body: Buffer | Uint8Array | string,
  contentType: string,
  acl: 'private' | 'public-read' = 'private'
): Promise<string> {
  await getS3Client().send(new PutObjectCommand({
    Bucket: DO_SPACES_BUCKET,
    Key: objectKey,
    Body: body,
    ContentType: contentType,
    ACL: acl,
  }));
  logger.info(`Uploaded to Spaces: ${objectKey}`);
  return acl === 'public-read' ? getCdnUrl(objectKey) : objectKey;
}

// ---------------------------------------------------------------------------
// Recording-specific helpers
// ---------------------------------------------------------------------------

export function getRecordingObjectKey(roomId: string, recordingId: string): string {
  return `recordings/${roomId}/${recordingId}.ogg`;
}

export async function getRecordingPresignedUrl(
  objectKey: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  return getPresignedUrl(objectKey, expiresInSeconds);
}

export async function deleteRecordingFromSpaces(objectKey: string): Promise<void> {
  return deleteObject(objectKey);
}

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
