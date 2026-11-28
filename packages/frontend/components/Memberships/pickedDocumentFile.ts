import type { DocumentPickerAsset } from 'expo-document-picker';
import { File } from 'expo-file-system';

/** The bytes and metadata of a picked document, whichever platform picked it. */
export interface PickedDocumentFile {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * A picked document as a readable file. Native pickers hand back a cache URI,
 * read through `expo-file-system`; the web fork (`pickedDocumentFile.web.ts`)
 * uses the browser `File` the picker already holds, so the web bundle never
 * carries `expo-file-system`.
 */
export function pickedDocumentFile(asset: DocumentPickerAsset): PickedDocumentFile {
  return asset.file ?? new File(asset.uri);
}
