/**
 * Blob utility module using expo-blob
 * 
 * expo-blob provides a web standards-compliant Blob implementation for React Native
 * that offers superior performance and works consistently across all platforms.
 * It is more reliable compared to the implementation exported from react-native,
 * especially with the slice() method and other Web API features.
 * 
 * Usage:
 *   import { Blob } from '@/utils/blob';
 *   
 *   // Create a blob from text
 *   const blob = new Blob(['Hello, World!'], { type: 'text/plain' });
 *   const text = await blob.text();
 *   
 *   // Create a blob from binary data
 *   const binaryBlob = new Blob([new Uint8Array([1, 2, 3, 4])], {
 *     type: 'application/octet-stream',
 *   });
 *   
 *   // Slice a blob
 *   const slice = blob.slice(0, 5);
 *   const slicedText = await slice.text();
 */

import { Blob as ExpoBlob } from 'expo-blob';

/**
 * Blob implementation using expo-blob
 * 
 * expo-blob works on both web and native platforms, providing:
 * - Web standards-compliant implementation
 * - Superior performance compared to React Native's Blob
 * - Consistent behavior across all platforms
 * - Proper slice() method support (unlike React Native's Blob)
 */
export { ExpoBlob as Blob };

/**
 * BlobPart represents acceptable values for Blob constructor
 * Can be: string | ArrayBuffer | ArrayBufferView | Blob
 */
export type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob | Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/**
 * Helper function to create a Blob from text
 */
export function createTextBlob(text: string, mimeType: string = 'text/plain'): Blob {
  return new Blob([text], { type: mimeType });
}

/**
 * Helper function to create a Blob from binary data
 */
export function createBinaryBlob(
  data: ArrayBuffer | Uint8Array | ArrayBufferView | BlobPart,
  mimeType: string = 'application/octet-stream'
): Blob {
  return new Blob([data as any], { type: mimeType });
}

/**
 * Helper function to create a Blob from mixed content
 */
export function createMixedBlob(
  parts: (string | ArrayBuffer | ArrayBufferView | Blob)[],
  mimeType: string = ''
): Blob {
  return new Blob(parts as any, { type: mimeType });
}

/**
 * Helper function to check if a value is a Blob
 */
export function isBlob(value: any): value is Blob {
  return value instanceof Blob;
}

/**
 * Helper function to get blob info
 */
export function getBlobInfo(blob: Blob): { size: number; type: string } {
  return {
    size: blob.size,
    type: blob.type,
  };
}

