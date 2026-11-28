import { linkPreviewImageSources } from '../linkPreviewImage';

describe('linkPreviewImageSources', () => {
  const image = 'https://api.clarity.surf/images/documents/doc-1/0123456789abcdef';

  it('offers every rendition Clarity keeps, smallest first, and nothing larger', () => {
    expect(linkPreviewImageSources(image)).toEqual([
      { uri: `${image}?variant=w320`, width: 320 },
      { uri: `${image}?variant=w640`, width: 640 },
      { uri: `${image}?variant=w1280`, width: 1280 },
    ]);
  });

  it('gives no sources when the document has no image', () => {
    expect(linkPreviewImageSources(undefined)).toBeUndefined();
    expect(linkPreviewImageSources('')).toBeUndefined();
  });
});
