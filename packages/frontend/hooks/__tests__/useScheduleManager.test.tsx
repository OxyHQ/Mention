import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';
import type { TFunction } from 'i18next';

import { useScheduleManager } from '../useScheduleManager';
import type { ScheduleOption, ScheduleSheetProps } from '@/components/Compose/ScheduleSheet';

/**
 * Every composer state can be scheduled, including a THREAD.
 *
 * The composer used to refuse: thread continuations are created as replies to
 * one another, and publishing them independently could put an answer on screen
 * before the post it answers. That is a real problem, but it is a PUBLISH-path
 * problem — the server refuses to claim a post whose parent has not published,
 * and the sweep walks each chain parent-first — so there is nothing left for the
 * composer to gate on, and the gate is gone rather than merely defaulted open.
 *
 * These cases pin the absence: the schedule sheet opens on request, carrying the
 * time already chosen, and no state of the composer produces a refusal toast.
 * Re-introduce any early return in `openScheduleSheet` and they fail.
 */

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

/** A sheet component that records the props the manager handed it. */
const capturedSheetProps: ScheduleSheetProps[] = [];
const ScheduleSheetStub: React.ComponentType<ScheduleSheetProps> = (props) => {
  capturedSheetProps.push(props);
  return <View />;
};

function setup() {
  const openBottomSheet = jest.fn();
  const setBottomSheetContent = jest.fn();
  const toast = jest.fn();
  const bottomSheet = {
    openBottomSheet,
    setBottomSheetContent,
    bottomSheetRef: { current: null },
  };

  let api: ReturnType<typeof useScheduleManager> | undefined;
  const Probe = () => {
    api = useScheduleManager({ bottomSheet, t, toast: toast as never });
    return null;
  };

  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<Probe />);
  });
  if (!api || !tree) throw new Error('useScheduleManager failed to mount');

  return {
    get api() {
      if (!api) throw new Error('hook unmounted');
      return api;
    },
    openBottomSheet,
    setBottomSheetContent,
    toast,
    tree,
  };
}

/** Render whatever the manager pushed into the sheet, to read its props. */
function renderSheetContent(content: unknown) {
  capturedSheetProps.length = 0;
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(content as React.ReactElement);
  });
  act(() => tree?.unmount());
  return capturedSheetProps.at(-1);
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

describe('useScheduleManager', () => {
  it('opens the schedule sheet on request', () => {
    const harness = setup();

    act(() => harness.api.openScheduleSheet(ScheduleSheetStub));

    expect(harness.setBottomSheetContent).toHaveBeenCalledTimes(1);
    expect(harness.openBottomSheet).toHaveBeenCalledWith(true);
    // A refusal here is exactly the behaviour that is gone.
    expect(harness.toast).not.toHaveBeenCalled();

    act(() => harness.tree.unmount());
  });

  it('opens it again after a time has been chosen, carrying that time', () => {
    const harness = setup();
    const chosen = new Date(Date.now() + 60 * 60 * 1000);

    act(() => harness.api.handleScheduleSelect(chosen));
    act(() => harness.api.openScheduleSheet(ScheduleSheetStub));

    const props = renderSheetContent(harness.setBottomSheetContent.mock.calls.at(-1)?.[0]);
    expect(props?.scheduledAt).toEqual(chosen);
    expect(props?.options.length).toBeGreaterThan(0);

    act(() => harness.tree.unmount());
  });

  it('clears a chosen time without re-opening anything', () => {
    const harness = setup();

    act(() => harness.api.handleScheduleSelect(new Date(Date.now() + 60_000)));
    act(() => harness.api.clearSchedule({ silent: true }));
    act(() => harness.api.openScheduleSheet(ScheduleSheetStub));

    const props = renderSheetContent(harness.setBottomSheetContent.mock.calls.at(-1)?.[0]);
    expect(props?.scheduledAt).toBeNull();

    act(() => harness.tree.unmount());
  });
});

/**
 * The quick-pick options are built from the wall clock, and "Later today" turns
 * over at 17:00: before it, the option is TODAY at 17:00; at or after it, the
 * option rolls to TOMORROW at 17:00. Against a real clock only one side of that
 * boundary ever runs, and which one depends on what time of day the suite is
 * started — so the clock is frozen here and both sides are pinned.
 *
 * The frozen instants are built with the multi-argument `Date` constructor,
 * which reads LOCAL time, exactly as the `setHours` calls in the hook do. A
 * `'2026-01-15T18:30:00Z'` fixture would be a UTC instant compared against a
 * local-time boundary, re-introducing the timezone dependency these cases exist
 * to remove.
 */
describe('useScheduleManager quick-pick options', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Open the sheet with the clock frozen at `now`, and read back the options. */
  function optionsAt(now: Date) {
    jest.useFakeTimers();
    jest.setSystemTime(now);

    const harness = setup();
    act(() => harness.api.openScheduleSheet(ScheduleSheetStub));
    const props = renderSheetContent(harness.setBottomSheetContent.mock.calls.at(-1)?.[0]);
    act(() => harness.tree.unmount());

    if (!props) throw new Error('the manager pushed no sheet content');
    return props.options;
  }

  /** The one option under test, by key, so a reordering cannot silently pass. */
  function dateOf(options: readonly ScheduleOption[], key: string) {
    const option = options.find((candidate) => candidate.key === key);
    if (!option) throw new Error(`no "${key}" option was offered`);
    return option.date;
  }

  it('offers "Later today" at 17:00 today when the clock is before 17:00', () => {
    const options = optionsAt(new Date(2026, 0, 15, 8, 0, 0));

    expect(dateOf(options, 'later')).toEqual(new Date(2026, 0, 15, 17, 0, 0, 0));
    expect(dateOf(options, 'tomorrow')).toEqual(new Date(2026, 0, 16, 9, 0, 0, 0));
    expect(dateOf(options, '15m')).toEqual(new Date(2026, 0, 15, 8, 15, 0, 0));
  });

  it('rolls "Later today" to 17:00 tomorrow once 17:00 has passed', () => {
    const options = optionsAt(new Date(2026, 0, 15, 18, 30, 0));

    expect(dateOf(options, 'later')).toEqual(new Date(2026, 0, 16, 17, 0, 0, 0));
    expect(dateOf(options, 'tomorrow')).toEqual(new Date(2026, 0, 16, 9, 0, 0, 0));
    expect(dateOf(options, '3h')).toEqual(new Date(2026, 0, 15, 21, 30, 0, 0));
  });

  it('rolls over on the boundary itself — 17:00 exactly is already past', () => {
    const options = optionsAt(new Date(2026, 0, 15, 17, 0, 0));

    expect(dateOf(options, 'later')).toEqual(new Date(2026, 0, 16, 17, 0, 0, 0));
  });
});
