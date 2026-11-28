// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import TestRenderer, { act } from 'react-test-renderer';

import { useHoldForLeading } from '../holdForLeading';

const seen: boolean[] = [];
function Probe({ pending, ready }: { pending: boolean | undefined; ready: boolean }) {
  seen.push(useHoldForLeading(pending, ready));
  return null;
}

function mount(pending: boolean | undefined, ready: boolean) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe pending={pending} ready={ready} />);
  });
  const set = (nextPending: boolean | undefined, nextReady: boolean) =>
    act(() => renderer.update(<Probe pending={nextPending} ready={nextReady} />));
  return { set, unmount: () => act(() => renderer.unmount()) };
}

describe('useHoldForLeading — a profile pinned post and its feed appear together (#1216)', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it('holds while the pinned post is pending, even with the first page ready', () => {
    const { set, unmount } = mount(true, false);
    expect(seen.at(-1)).toBe(true);
    set(true, true);
    expect(seen.at(-1)).toBe(true);
    set(false, true);
    expect(seen.at(-1)).toBe(false);
    unmount();
  });

  it('holds a settled pinned post until the first page is ready', () => {
    const { set, unmount } = mount(true, false);
    set(false, false);
    expect(seen.at(-1)).toBe(true);
    set(false, true);
    expect(seen.at(-1)).toBe(false);
    unmount();
  });

  it('never holds a feed with nothing pending', () => {
    const { unmount } = mount(undefined, true);
    expect(seen).toEqual([false]);
    unmount();
  });

  it('latches: once presented, a later refetch or reload never hides the feed again', () => {
    const { set, unmount } = mount(false, true);
    set(true, false);
    expect(seen.at(-1)).toBe(false);
    unmount();
  });
});
