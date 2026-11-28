// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import {
  mediaInputSchema,
  pollInputSchema,
  postContentSchema,
} from '../lib/post-content-schema.js';

describe('post-content-schema', () => {
  it('accepts fileId media', () => {
    const parsed = mediaInputSchema.parse({
      kind: 'fileId',
      fileId: 'abc123',
      type: 'image',
    });
    expect(parsed.kind).toBe('fileId');
  });

  it('rejects poll with one option', () => {
    expect(() => pollInputSchema.parse({ question: 'Q?', options: ['only'] })).toThrow();
  });

  it('accepts full post content', () => {
    const parsed = postContentSchema.parse({
      text: 'hello',
      media: [{ kind: 'url', url: 'https://example.com/a.jpg' }],
      poll: { question: 'Pick', options: ['A', 'B'] },
    });
    expect(parsed.text).toBe('hello');
    expect(parsed.media?.[0]?.kind).toBe('url');
  });
});
