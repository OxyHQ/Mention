import mongoose from 'mongoose';
import multer from 'multer';
import { GridFSBucket } from 'mongodb';
import { Request } from 'express';
import { Readable } from 'stream';

let bucket: GridFSBucket;

// Initialize GridFSBucket
const initGridFS = () => {
  if (!bucket && mongoose.connection.db) {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'uploads'
    });
  }
  return bucket;
};

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5 // Maximum 5 files per upload
  }
}).array('files', 5);

// Helper function to write file to GridFS
const writeFile = async (fileBuffer: Buffer, options: any) => {
  const bucket = initGridFS();
  if (!bucket) throw new Error('GridFS not initialized');

  // Use sanitized filename for storage while preserving original in metadata
  const safeFilename = `file-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  const uploadStream = bucket.openUploadStream(safeFilename, {
    contentType: options.contentType || 'application/octet-stream',
    metadata: {
      ...options.metadata,
      originalFilename: options.filename, // Store the original user-provided filename
      sanitizedFilename: safeFilename,    // Store the safe internal filename
      uploadDate: new Date()
    }
  });

  return new Promise((resolve, reject) => {
    const readableStream = Readable.from(fileBuffer);
    readableStream
      .pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => {
        resolve({
          _id: uploadStream.id,
          filename: safeFilename,
          contentType: options.contentType || 'application/octet-stream',
          metadata: {
            ...uploadStream.options.metadata,
            originalFilename: options.filename
          }
        });
      });
  });
};

// Helper function to read file from GridFS
const readFile = async (id: string) => {
  const bucket = initGridFS();
  if (!bucket) throw new Error('GridFS not initialized');
  
  return bucket.openDownloadStream(new mongoose.Types.ObjectId(id));
};

// Helper function to delete file from GridFS
const deleteFile = async (id: string) => {
  const bucket = initGridFS();
  if (!bucket) throw new Error('GridFS not initialized');

  return bucket.delete(new mongoose.Types.ObjectId(id));
};

// Helper function to find files
const findFiles = async (query: any) => {
  const bucket = initGridFS();
  if (!bucket) throw new Error('GridFS not initialized');

  return bucket.find(query).toArray();
};

export {
  initGridFS,
  upload,
  writeFile,
  readFile,
  deleteFile,
  findFiles
};