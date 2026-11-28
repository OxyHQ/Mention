import type { DocumentPickerAsset } from 'expo-document-picker';
import type { PickedDocumentFile } from './pickedDocumentFile';

/**
 * WEB: the picker resolves every asset with the browser `File` it read, so
 * there is no URI to open. See `pickedDocumentFile.ts`.
 */
export function pickedDocumentFile(asset: DocumentPickerAsset): PickedDocumentFile {
  if (!asset.file) throw new Error('The picked document has no file');
  return asset.file;
}
