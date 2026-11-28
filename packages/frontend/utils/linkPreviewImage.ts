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
