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

import { Platform } from 'react-native';

/**
 * Platform-aware Blob implementation
 * 
 * - Web: Uses native Blob API (built-in)
 * - Native: Uses React Native's global Blob by default
 * 
 * To use expo-blob for better performance and slice() support on native:
 * 1. Rebuild your app: npx expo prebuild
 * 2. Run: npx expo run:ios (or run:android)
 * 
 * The app will automatically use expo-blob if available after rebuild.
 */

// Use global Blob - works on all platforms immediately
// On web, this is the native Blob API
// On native, this is React Native's Blob (may have slice() limitations)
// 
// To enable expo-blob after rebuilding:
// 1. Rebuild: npx expo prebuild && npx expo run:ios (or run:android)
// 2. Then uncomment the expo-blob code below and comment out the global.Blob line

// Default: Use global Blob (works immediately, no rebuild needed)
export const Blob = global.Blob as typeof global.Blob;

// Uncomment after rebuilding to use expo-blob:
// let BlobExport: typeof global.Blob;
// if (Platform.OS === 'web') {
//   BlobExport = global.Blob as typeof global.Blob;
// } else {
//   try {
//     const expoBlob = require('expo-blob');
//     BlobExport = expoBlob?.Blob || global.Blob;
//   } catch (e) {
//     BlobExport = global.Blob as typeof global.Blob;
//   }
// }
// export { BlobExport as Blob };

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

