// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
