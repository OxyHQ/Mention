// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Hydration reads every rendition column except `search_vector`.
 *
 * The vector is about half a rendition row (~364 bytes against a ~238-byte
 * body in production) and nothing outside the text index reads it, so the
 * hydration select names its columns instead of `select()`-ing the row. This
 * pins both halves: the vector stays out, and a column added to the table
 * later is picked up without anyone remembering to list it.
 */

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

import { variantReadColumns } from '../../db/posts/postRepository';
import { postContentVariants } from '../../db/schema/postContent';

describe('rendition hydration columns', () => {
  it('reads every column but the search vector', () => {
    const all = Object.keys(getTableColumns(postContentVariants));

    expect(Object.keys(variantReadColumns)).not.toContain('searchVector');
    expect(Object.keys(variantReadColumns).sort()).toEqual(
      all.filter((name) => name !== 'searchVector').sort(),
    );
  });
});
