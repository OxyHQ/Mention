// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import type { MtnTrendNameFragmentConfig } from '@mention/shared-types';
import {
  buildNameFragmentPairs,
  findNameFragmentRelations,
  relationKey,
} from '../../services/trending/trendNameFragments';

const config: MtnTrendNameFragmentConfig = {
  enabled: true,
  maxVolumeRatio: 3,
  minSharedPosts: 1,
  minContainerShare: 0.2,
  ambiguityRatio: 2,
};

const volumes = (entries: Record<string, number>) => new Map(Object.entries(entries));
const shared = (entries: Record<string, number>) =>
  new Map(
    Object.entries(entries).map(([key, posts]) => {
      const [fragment, container] = key.split('>');
      return [relationKey(fragment, container), posts] as const;
    }),
  );

const link = (candidates: Record<string, number>, sharedPosts: Record<string, number>) => {
  const volumeOf = volumes(candidates);
  const relations = findNameFragmentRelations(
    [...volumeOf].map(([term, volume]) => ({ term, volume })),
    config,
  );
  return buildNameFragmentPairs(relations, shared(sharedPosts), volumeOf, config).map(
    (pair) => `${pair.a}->${pair.b}`,
  );
};

describe('name fragments', () => {
  it('joins a short form to the fuller name even on a single shared post', () => {
    expect(link({ mason: 6, 'chris mason': 4 }, { 'mason>chris mason': 1 })).toEqual([
      'mason->chris mason',
    ]);
  });

  it('joins a fragment to the ONE name it shares the most posts with', () => {
    // `huang` is written about Jensen far more than about Alice: it must not be
    // attached to both, which would fuse the two people through it.
    expect(
      link(
        { huang: 60, 'jensen huang': 70, 'alice huang': 20 },
        { 'huang>jensen huang': 30, 'huang>alice huang': 4 },
      ),
    ).toEqual(['huang->jensen huang']);
  });

  it('refuses a fragment split between two names with comparable evidence', () => {
    expect(
      link(
        { carolina: 10, 'north carolina': 20, 'south carolina': 11 },
        { 'carolina>north carolina': 5, 'carolina>south carolina': 4 },
      ),
    ).toEqual([]);
  });

  it('refuses a word that dwarfs the name it sits in, and one that shares only a sliver', () => {
    expect(link({ house: 250, 'white house': 70 }, { 'house>white house': 40 })).toEqual([]);
    expect(link({ board: 80, 'nvidia board': 60 }, { 'board>nvidia board': 6 })).toEqual([]);
  });

  it('compares whole words, so a short token is never inside a longer one', () => {
    expect(link({ us: 5, justice: 5, 'us justice': 5 }, { 'us>us justice': 5 })).toEqual([
      'us->us justice',
    ]);
    const relations = findNameFragmentRelations(
      [
        { term: 'us', volume: 5 },
        { term: 'justice league', volume: 5 },
      ],
      config,
    );
    expect(relations).toEqual([]);
  });

  it('is deterministic and does nothing when disabled', () => {
    const input = { foxx: 75, 'virginia foxx': 104, 'tammy foxx': 80 };
    const sharedPosts = { 'foxx>virginia foxx': 62, 'foxx>tammy foxx': 62 };
    expect(link(input, sharedPosts)).toEqual(link(input, sharedPosts));
    expect(
      findNameFragmentRelations([{ term: 'foxx', volume: 1 }], { ...config, enabled: false }),
    ).toEqual([]);
  });
});
