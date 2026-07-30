import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useDeferredToggle } from '../useDeferredToggle';

/**
 * The shared boolean toggle behind the profile's bell and its poke button.
 *
 * The behaviour worth pinning is the one that is invisible until the SECOND
 * press: which direction a press goes. The hook used to read that from a ref
 * mirrored during render — illegal input for the React Compiler — and a mirror
 * that lagged would send every press down the same branch, so the control would
 * latch on and never turn off again. Nothing about that is visible on the first
 * press, which is why it is asserted here rather than left to the screen.
 */

const DEFERRED_FETCH_DELAY_MS = 500;

type Handlers = {
  fetchStatus: jest.Mock<Promise<boolean>, []>;
  onEnable: jest.Mock<Promise<void>, []>;
  onDisable: jest.Mock<Promise<void>, []>;
};

type ToggleResult = ReturnType<typeof useDeferredToggle>;

let latest: ToggleResult | null = null;

function Probe({ skip, handlers }: { skip: boolean; handlers: Handlers }) {
  latest = useDeferredToggle({
    skip,
    fetchStatus: handlers.fetchStatus,
    onEnable: handlers.onEnable,
    onDisable: handlers.onDisable,
  });
  return null;
}

function makeHandlers(initialStatus: boolean): Handlers {
  return {
    fetchStatus: jest.fn(() => Promise.resolve(initialStatus)),
    onEnable: jest.fn(() => Promise.resolve()),
    onDisable: jest.fn(() => Promise.resolve()),
  };
}

/**
 * Mount, then let the deferred status fetch land. The 500ms wait is what the
 * screen really does, so a press after it is a press against a KNOWN status —
 * the case where the hook must not re-fetch and must trust its own state.
 */
async function mountSettled(handlers: Handlers) {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe skip={false} handlers={handlers} />);
  });
  await act(async () => {
    jest.advanceTimersByTime(DEFERRED_FETCH_DELAY_MS);
  });
  return renderer!;
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  jest.useFakeTimers();
  latest = null;
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('useDeferredToggle', () => {
  it('reverses direction on the second press', async () => {
    // The regression this exists for: press on, press off. Reading the previous
    // state from a stale mirror calls onEnable twice and the control sticks.
    const handlers = makeHandlers(false);
    const renderer = await mountSettled(handlers);

    await act(async () => {
      await latest!.toggle();
    });
    expect(handlers.onEnable).toHaveBeenCalledTimes(1);
    expect(handlers.onDisable).not.toHaveBeenCalled();
    expect(latest!.active).toBe(true);

    await act(async () => {
      await latest!.toggle();
    });
    expect(handlers.onDisable).toHaveBeenCalledTimes(1);
    expect(handlers.onEnable).toHaveBeenCalledTimes(1);
    expect(latest!.active).toBe(false);

    act(() => renderer.unmount());
  });

  it('turns OFF a status the deferred fetch discovered was already on', async () => {
    // Arriving at a profile already subscribed to: the first press must undo it.
    // A mirror seeded at `false` and never updated would subscribe again.
    const handlers = makeHandlers(true);
    const renderer = await mountSettled(handlers);

    expect(latest!.active).toBe(true);

    await act(async () => {
      await latest!.toggle();
    });
    expect(handlers.onDisable).toHaveBeenCalledTimes(1);
    expect(handlers.onEnable).not.toHaveBeenCalled();
    expect(latest!.active).toBe(false);

    act(() => renderer.unmount());
  });

  it('acts on the on-demand status when pressed before the deferred fetch fires', async () => {
    // Pressing inside the 500ms window: the hook fetches first, cancels the
    // timer, and must act on THAT answer — not on the `false` it mounted with,
    // and not on a re-render that has not happened yet.
    const handlers = makeHandlers(true);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe skip={false} handlers={handlers} />);
    });

    await act(async () => {
      await latest!.toggle();
    });

    expect(handlers.fetchStatus).toHaveBeenCalledTimes(1);
    expect(handlers.onDisable).toHaveBeenCalledTimes(1);
    expect(handlers.onEnable).not.toHaveBeenCalled();

    // The deferred timer was cancelled, so letting it come due fetches nothing more.
    await act(async () => {
      jest.advanceTimersByTime(DEFERRED_FETCH_DELAY_MS);
    });
    expect(handlers.fetchStatus).toHaveBeenCalledTimes(1);

    act(() => renderer!.unmount());
  });

  it('restores the previous state when the action fails', async () => {
    const handlers = makeHandlers(false);
    handlers.onEnable.mockRejectedValueOnce(new Error('nope'));
    const renderer = await mountSettled(handlers);

    await act(async () => {
      await expect(latest!.toggle()).rejects.toThrow('nope');
    });
    expect(latest!.active).toBe(false);

    // And the next press still goes the right way — the failed attempt must not
    // have moved what the hook believes the current state to be.
    await act(async () => {
      await latest!.toggle();
    });
    expect(handlers.onEnable).toHaveBeenCalledTimes(2);
    expect(handlers.onDisable).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('does nothing at all on a skipped profile', async () => {
    const handlers = makeHandlers(true);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe skip handlers={handlers} />);
    });
    await act(async () => {
      jest.advanceTimersByTime(DEFERRED_FETCH_DELAY_MS);
    });

    await act(async () => {
      await latest!.toggle();
    });

    expect(handlers.fetchStatus).not.toHaveBeenCalled();
    expect(handlers.onEnable).not.toHaveBeenCalled();
    expect(handlers.onDisable).not.toHaveBeenCalled();

    act(() => renderer!.unmount());
  });
});
