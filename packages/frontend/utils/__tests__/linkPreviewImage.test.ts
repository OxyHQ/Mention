// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
