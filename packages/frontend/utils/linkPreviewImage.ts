// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { contentImageSources, type ImageVariantSource } from '@oxy.so/utils/image';

/**
 * A link preview's cover image (a Clarity document's `imageUrl`) as one
 * candidate per rendition, smallest first, for an image component to choose
 * from by the space it is laid out in: a card in the 280px attachments row
 * loads `w640`, a full-width one `w1280`, never the site's original.
 *
 * `w1280` is the largest because it is the rendition Clarity keeps; a larger
 * rung would be the same bytes under another URL, cached twice.
 */
export function linkPreviewImageSources(url: string | undefined): ImageVariantSource[] | undefined {
  return url ? contentImageSources(url, 'w1280') : undefined;
}
