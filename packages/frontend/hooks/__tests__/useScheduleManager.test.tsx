import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';
import type { TFunction } from 'i18next';

import { useScheduleManager } from '../useScheduleManager';
import type { ScheduleSheetProps } from '@/components/Compose/ScheduleSheet';

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
