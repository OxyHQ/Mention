// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import type { TrendGraphEdgeDTO, TrendGraphNodeDTO } from '@mention/shared-types';
import { relatedTrends } from '../../services/trending/trendTopic';

const node = (term: string, volume: number, displayName?: string): TrendGraphNodeDTO => ({
  term,
  volume,
  authorCount: volume,
  languages: [],
  regions: [],
  ...(displayName ? { displayName } : {}),
});

describe('relatedTrends — what co-occurs with this topic', () => {
  it('reads an edge from either end and keeps the strongest per trend', () => {
    const nodes = [node('jensen huang', 18, 'Jensen Huang'), node('nvidia', 21), node('ceo', 34)];
    const edges: TrendGraphEdgeDTO[] = [
      { a: 'jensen huang', b: 'nvidia', posts: 3, linked: false, strength: 0.15 },
      { a: 'nvidia', b: 'jensen huang', posts: 9, linked: true, strength: 0.6 },
      { a: 'ceo', b: 'jensen huang', posts: 8, linked: false, strength: 0.32 },
    ];

    expect(relatedTrends('jensen huang', nodes, edges)).toEqual([
      { term: 'nvidia', volume: 21, authorCount: 21, strength: 0.6 },
      { term: 'ceo', volume: 34, authorCount: 34, strength: 0.32 },
    ]);
  });

  it('drops an edge whose other end has no node behind it', () => {
    const edges: TrendGraphEdgeDTO[] = [
      { a: 'jensen huang', b: 'ghost', posts: 9, linked: true, strength: 0.9 },
    ];
    expect(relatedTrends('jensen huang', [node('jensen huang', 18)], edges)).toEqual([]);
  });
});
