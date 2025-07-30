/**
 * Media-related types for Mention social network
 */

import { Timestamps } from './common';

export enum MediaType {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  GIF = 'gif',
  DOCUMENT = 'document'
}

export enum MediaStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
  DELETED = 'deleted'
}

export interface Media {
  id: string;
  _id?: string;
  type: MediaType;
  status: MediaStatus;
  url: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  size: number; // in bytes
  dimensions?: MediaDimensions;
  duration?: number; // for videos/audio in seconds
  metadata: MediaMetadata;
  uploaderOxyUserId: string; // Links to Oxy user
  postId?: string; // if attached to a post
  createdAt: string;
  updatedAt: string;
}

export interface MediaDimensions {
  width: number;
  height: number;
}

export interface MediaMetadata {
  title?: string;
  description?: string;
  altText?: string;
  tags?: string[];
  location?: string;
  device?: string;
  software?: string;
  isSensitive?: boolean;
  isNSFW?: boolean;
  hasAudio?: boolean; // for videos
  bitrate?: number; // for videos/audio
  fps?: number; // for videos
  codec?: string; // for videos/audio
}

export interface ImageMedia extends Media {
  type: MediaType.IMAGE;
  dimensions: MediaDimensions;
  exif?: ImageExif;
}

export interface VideoMedia extends Media {
  type: MediaType.VIDEO;
  dimensions: MediaDimensions;
  duration: number;
  thumbnailUrl: string;
  previewUrl: string;
  videoMetadata: VideoMetadata;
}

export interface AudioMedia extends Media {
  type: MediaType.AUDIO;
  duration: number;
  audioMetadata: AudioMetadata;
}

export interface GifMedia extends Media {
  type: MediaType.GIF;
  dimensions: MediaDimensions;
  duration: number;
  isAnimated: boolean;
}

export interface DocumentMedia extends Media {
  type: MediaType.DOCUMENT;
  pageCount?: number;
  documentMetadata: DocumentMetadata;
}

export interface ImageExif {
  camera?: string;
  lens?: string;
  aperture?: string;
  shutterSpeed?: string;
  iso?: number;
  focalLength?: number;
  flash?: boolean;
  dateTaken?: string;
  gps?: {
    latitude: number;
    longitude: number;
  };
}

export interface VideoMetadata {
  bitrate: number;
  fps: number;
  codec: string;
  hasAudio: boolean;
  audioCodec?: string;
  audioBitrate?: number;
  resolution: string;
  aspectRatio: string;
}

export interface AudioMetadata {
  bitrate: number;
  codec: string;
  sampleRate: number;
  channels: number;
  duration: number;
}

export interface DocumentMetadata {
  pageCount?: number;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
}

export interface MediaUploadRequest {
  file: File;
  type: MediaType;
  metadata?: Partial<MediaMetadata>;
  postId?: string;
}

export interface MediaUploadResponse {
  media: Media;
  uploadUrl?: string; // for multipart uploads
  uploadId?: string; // for multipart uploads
}

export interface MediaUploadProgress {
  uploadId: string;
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  status: MediaStatus;
}

export interface MediaFilters {
  type?: MediaType;
  status?: MediaStatus;
  uploaderOxyUserId?: string;
  postId?: string;
  dateFrom?: string;
  dateTo?: string;
  isSensitive?: boolean;
  hasAudio?: boolean;
  minSize?: number;
  maxSize?: number;
}

export interface MediaProcessingJob {
  id: string;
  mediaId: string;
  type: 'thumbnail' | 'preview' | 'transcode' | 'optimize';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface MediaUsage {
  id: string;
  mediaId: string;
  postId: string;
  oxyUserId: string;
  usageType: 'primary' | 'secondary' | 'thumbnail';
  createdAt: string;
}

export interface MediaStats {
  totalUploads: number;
  totalSize: number;
  byType: Record<MediaType, number>;
  byStatus: Record<MediaStatus, number>;
  averageFileSize: number;
  mostUsedMedia: Media[];
} 