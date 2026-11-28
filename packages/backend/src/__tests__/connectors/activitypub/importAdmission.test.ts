// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'vitest';
import {
  discoveryAdmission,
  isWorthImporting,
  PROBATION_POST_LIMIT,
} from '../../../connectors/activitypub/importAdmission';

const person = 'https://mastodon.example/users/sara';
const bridge = 'https://bird.makeup/users/sara';

describe('discoveryAdmission', () => {
  it('copies an account a local user follows in full, unfiltered', () => {
    expect(discoveryAdmission({ followedLocally: true, actorUri: person, fullLimit: 100 })).toEqual(
      {
        limit: 100,
        skip: false,
        filterContent: false,
      },
    );
    expect(
      discoveryAdmission({ followedLocally: true, actorUri: bridge, fullLimit: 100 }).skip,
    ).toBe(false);
  });

  it('puts any other account on probation, filtered by content', () => {
    expect(
      discoveryAdmission({ followedLocally: false, actorUri: person, fullLimit: 100 }),
    ).toEqual({
      limit: PROBATION_POST_LIMIT,
      skip: false,
      filterContent: true,
    });
  });

  it('skips a bridged X account nobody follows', () => {
    expect(
      discoveryAdmission({ followedLocally: false, actorUri: bridge, fullLimit: 100 }).skip,
    ).toBe(true);
  });
});

describe('isWorthImporting', () => {
  const note = (content: string) => ({ content });
  const actor = { type: 'Person', domain: 'mastodon.example' };

  it('drops decoration and a bare link, keeps prose', () => {
    expect(isWorthImporting(note('<p>🫂</p>'), actor)).toBe(false);
    expect(isWorthImporting(note('<p></p>'), actor)).toBe(false);
    expect(
      isWorthImporting(
        note(
          '<p>Proof, understanding, and hand-verification were interwoven in mathematics in a very special way that is now unwinding.</p>',
        ),
        actor,
      ),
    ).toBe(true);
  });
});
