/**
 * The Videos tab's prewarm holds only while it costs the reader nothing they
 * would notice: foreground, online and unmetered, and no video playing.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockState = { foreground: true, online: true, metered: false, playing: false };
jest.mock('@oxy.so/bloom/hooks', () => ({ useAppForeground: () => mockState.foreground }));
jest.mock('@oxy.so/bloom/connection-status', () => ({
  useNetworkStatus: () => ({ online: mockState.online, metered: mockState.metered }),
}));
jest.mock('@/stores/videoPlayerRegistry', () => ({
  useAnyVideoPlaying: () => mockState.playing,
}));

import { useReelPrewarm } from '../useReelPrewarm';

function read(): boolean {
  let value = false;
  function Probe() {
    value = useReelPrewarm();
    return null;
  }
  act(() => {
    TestRenderer.create(<Probe />);
  });
  return value;
}

beforeEach(() =>
  Object.assign(mockState, { foreground: true, online: true, metered: false, playing: false }),
);

it('prewarms on an unmetered connection with the app in front and nothing playing', () => {
  expect(read()).toBe(true);
});

it.each([
  ['in the background', { foreground: false }],
  ['offline', { online: false }],
  ['on a metered connection', { metered: true }],
  ['while a video plays', { playing: true }],
])('does not prewarm %s', (_name, change) => {
  Object.assign(mockState, change);
  expect(read()).toBe(false);
});
