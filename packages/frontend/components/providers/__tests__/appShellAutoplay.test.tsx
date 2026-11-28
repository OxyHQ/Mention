// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { AgeProtections } from '@oxy.so/contracts/client';
import { AppShellProviders } from '../AppShellProviders';

/**
 * A minor's account never autoplays (oxy ADR 0068): the one playback authority
 * is told so. Nobody else's own autoplay setting is overridden, which is what
 * passing nothing means.
 */

const mockPlaybackProps: Array<{ autoplay?: boolean }> = [];
jest.mock('@oxy.so/bloom/video-playback', () => ({
  VideoPlaybackProvider: (props: { autoplay?: boolean; children: React.ReactNode }) => {
    mockPlaybackProps.push({ autoplay: props.autoplay });
    return props.children;
  },
}));
jest.mock('@/components/navigation/MentionNavigation', () => ({
  MentionNavigation: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../CommunityNoteProvider', () => ({
  CommunityNoteProvider: ({ children }: { children: React.ReactNode }) => children,
}));

let mockProtections: AgeProtections;
jest.mock('@/hooks/useAgeProtections', () => ({
  useAgeProtections: () => mockProtections,
}));

function autoplayFor(protections: AgeProtections): boolean | undefined {
  mockProtections = protections;
  mockPlaybackProps.length = 0;
  act(() => {
    TestRenderer.create(
      <AppShellProviders>
        <></>
      </AppShellProviders>,
    );
  });
  expect(mockPlaybackProps).toHaveLength(1);
  return mockPlaybackProps[0].autoplay;
}

describe('AppShellProviders and autoplay', () => {
  it('turns autoplay off for a protected profile', () => {
    expect(
      autoplayFor({
        feedProfile: 'protected',
        autoplay: 'never',
        quietHours: { start: '22:00', end: '07:00' },
      }),
    ).toBe(false);
  });

  it('leaves autoplay to the person’s own setting otherwise', () => {
    expect(
      autoplayFor({ feedProfile: 'standard', autoplay: 'personal', quietHours: null }),
    ).toBeUndefined();
  });
});
