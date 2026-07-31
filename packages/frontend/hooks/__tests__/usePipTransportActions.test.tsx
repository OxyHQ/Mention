import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  buildPipTransportActions,
  usePipTransportActions,
} from '../usePipTransportActions';
import type {
  PipTransportAction,
  PipTransportActionEvent,
} from '@/modules/pip-transport';

/**
 * The JS half of the Android Picture-in-Picture transport: which buttons the
 * window is asked for, how that list shrinks to what the device will actually
 * show, when it is published and withdrawn, and where a press ends up.
 *
 * Nothing here says anything about Android. No `RemoteAction`, no
 * `PendingIntent`, no OS window and no broadcast is reachable from jest — that
 * needs a device build. What IS pinned is every decision made before the native
 * call, plus the requirement that a build without the module does nothing at all
 * rather than throwing.
 */

// Prefixed `mock` so the hoisted `jest.mock` factories may reference it. Nothing
// below dereferences it while the factory is being DEFINED, only when the mocked
// functions are called, which is after this initialiser has run.
const mockNative = {
  available: true,
  maxActions: 3,
  published: [] as PipTransportAction[][],
  clearCount: 0,
  listeners: [] as ((event: PipTransportActionEvent) => void)[],
  removeCount: 0,
  publishRejection: null as Error | null,
};

const mockDebug = jest.fn();

jest.mock('@/lib/logger', () => ({
  createScopedLogger: () => ({ debug: (...args: unknown[]) => mockDebug(...args) }),
}));

jest.mock('@/modules/pip-transport', () => ({
  // A getter, not a value: the flag is a module CONSTANT in the real module, so
  // each test has to be able to move it before the hook reads it.
  get isPipTransportAvailable() {
    return mockNative.available;
  },
  getMaxPipActions: () => mockNative.maxActions,
  setPipActions: (actions: readonly PipTransportAction[]) => {
    mockNative.published.push([...actions]);
    return mockNative.publishRejection
      ? Promise.reject(mockNative.publishRejection)
      : Promise.resolve();
  },
  clearPipActions: () => {
    mockNative.clearCount += 1;
    return Promise.resolve();
  },
  addPipActionListener: (listener: (event: PipTransportActionEvent) => void) => {
    // The real binding returns `null` where the module is missing — there is
    // nothing to unsubscribe from.
    if (!mockNative.available) return null;
    mockNative.listeners.push(listener);
    return {
      remove: () => {
        mockNative.removeCount += 1;
        mockNative.listeners = mockNative.listeners.filter((entry) => entry !== listener);
      },
    };
  },
}));

const LABELS = { nextLabel: 'Next video', previousLabel: 'Previous video' };

const onNext = jest.fn();
const onPrevious = jest.fn();

function Probe({
  active,
  next = onNext,
  previous = onPrevious,
}: {
  active: boolean;
  next?: () => void;
  previous?: () => void;
}) {
  usePipTransportActions({ active, ...LABELS, onNext: next, onPrevious: previous });
  return null;
}

function render(active = true): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<Probe active={active} />);
  });
  if (!renderer) throw new Error('renderer was not created');
  return renderer;
}

/** Fire a button press the way the native receiver's event would. */
function press(id: PipTransportActionEvent['id']): void {
  const listener = mockNative.listeners.at(-1);
  if (!listener) throw new Error('nothing is listening for Picture-in-Picture actions');
  act(() => listener({ id }));
}

beforeEach(() => {
  mockNative.available = true;
  mockNative.maxActions = 3;
  mockNative.published = [];
  mockNative.clearCount = 0;
  mockNative.listeners = [];
  mockNative.removeCount = 0;
  mockNative.publishRejection = null;
  mockDebug.mockClear();
  onNext.mockClear();
  onPrevious.mockClear();
});

describe('PiP transport actions — the list', () => {
  it('offers previous then next when the window has room for both', () => {
    expect(buildPipTransportActions({ next: 'N', previous: 'P' }, 3)).toEqual([
      { id: 'previous', title: 'P' },
      { id: 'next', title: 'N' },
    ]);
    // Two is the same answer: the clamp only bites below the list's own length.
    expect(buildPipTransportActions({ next: 'N', previous: 'P' }, 2)).toEqual([
      { id: 'previous', title: 'P' },
      { id: 'next', title: 'N' },
    ]);
  });

  it('keeps NEXT when the device shows only one action', () => {
    // A reel is watched forwards, so the single surviving control is "next" —
    // the clamp drops the least useful button, not the last one written down.
    expect(buildPipTransportActions({ next: 'N', previous: 'P' }, 1)).toEqual([
      { id: 'next', title: 'N' },
    ]);
  });

  it('offers nothing when the device shows no actions', () => {
    expect(buildPipTransportActions({ next: 'N', previous: 'P' }, 0)).toEqual([]);
  });
});

describe('PiP transport actions — lifecycle', () => {
  it('publishes the actions when the session opens', () => {
    render();

    expect(mockNative.published).toEqual([[
      { id: 'previous', title: 'Previous video' },
      { id: 'next', title: 'Next video' },
    ]]);
  });

  it('publishes nothing while no session is open', () => {
    render(false);

    expect(mockNative.published).toEqual([]);
    expect(mockNative.listeners).toEqual([]);
  });

  it('withdraws them when the session closes', () => {
    const renderer = render();
    act(() => {
      renderer.update(<Probe active={false} />);
    });

    expect(mockNative.clearCount).toBe(1);
  });

  it('withdraws them on unmount', () => {
    const renderer = render();
    act(() => {
      renderer.unmount();
    });

    expect(mockNative.clearCount).toBe(1);
  });

  it('asks for only what the device will show', () => {
    // The cap is a runtime query on the device, so the published list has to be
    // built from the answer rather than from an assumed three.
    mockNative.maxActions = 1;
    render();

    expect(mockNative.published).toEqual([[{ id: 'next', title: 'Next video' }]]);
  });

  it('publishes nothing — and withdraws nothing — where the window shows no actions', () => {
    mockNative.maxActions = 0;
    const renderer = render();
    act(() => {
      renderer.unmount();
    });

    expect(mockNative.published).toEqual([]);
    // Nothing was published, so a withdrawal would be a native call made for a
    // window that never had our buttons.
    expect(mockNative.clearCount).toBe(0);
  });

  it('does nothing at all in a build without the native module', () => {
    mockNative.available = false;

    expect(() => render()).not.toThrow();
    expect(mockNative.published).toEqual([]);
    expect(mockNative.listeners).toEqual([]);
  });

  it('survives a publish the activity refuses', async () => {
    mockNative.publishRejection = new Error('This activity cannot show Picture-in-Picture actions');

    expect(() => render()).not.toThrow();
    // Awaiting a resolved promise lets the rejection handler run. Not merely
    // "did not crash": the failure has to be reported somewhere, or a window
    // silently without buttons is indistinguishable from a working one.
    await act(async () => {});
    expect(mockDebug).toHaveBeenCalledWith(
      'Could not publish Picture-in-Picture actions',
      expect.objectContaining({ error: mockNative.publishRejection }),
    );
  });
});

describe('PiP transport actions — presses', () => {
  it('routes a next press to the session', () => {
    render();
    press('next');

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it('routes a previous press to the session', () => {
    render();
    press('previous');

    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('presses the handlers of the LATEST render, without re-subscribing', () => {
    // The screen's handlers are rebuilt on every pager move. Re-subscribing on
    // each one would tear the native receiver down and back up several times a
    // scroll, so the subscription must outlive them — and still call the current
    // pair, not the one it was created with.
    const renderer = render();
    const laterNext = jest.fn();
    act(() => {
      renderer.update(<Probe active next={laterNext} />);
    });

    expect(mockNative.listeners).toHaveLength(1);
    expect(mockNative.removeCount).toBe(0);

    press('next');
    expect(laterNext).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('stops listening when the session closes', () => {
    const renderer = render();
    act(() => {
      renderer.update(<Probe active={false} />);
    });

    expect(mockNative.removeCount).toBe(1);
    expect(mockNative.listeners).toEqual([]);
  });
});
