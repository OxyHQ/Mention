// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { isActivityPubAccept } from '../../connectors/activitypub/constants';

describe('isActivityPubAccept', () => {
  it('matches ActivityPub and JSON-LD Accept variants used for actor discovery', () => {
    expect(isActivityPubAccept('application/activity+json')).toBe(true);
    expect(isActivityPubAccept('Application/Activity+Json')).toBe(true);
    expect(isActivityPubAccept('application/ld+json')).toBe(true);
    expect(
      isActivityPubAccept('application/ld+json; profile="https://www.w3.org/ns/activitystreams"'),
    ).toBe(true);
    expect(isActivityPubAccept('text/html, application/ld+json;q=0.9')).toBe(true);
  });

  it('does not match ordinary browser HTML requests', () => {
    expect(isActivityPubAccept(undefined)).toBe(false);
    expect(isActivityPubAccept('text/html,application/xhtml+xml')).toBe(false);
  });
});
