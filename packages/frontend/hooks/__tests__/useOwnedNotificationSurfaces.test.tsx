import { StrictMode, useEffect, useLayoutEffect } from 'react';
import { renderToString } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { useOwnedNotificationSurfaces } from '../useOwnedNotificationSurfaces';
import type { NotificationIntent } from '@/types/notificationIntent';

type Present = (signal: AbortSignal) => Promise<string>;
type Open = (intent: NotificationIntent, present: Present) => Promise<string | undefined>;

it.each(['logout', 'ABA', 'same-account replacement'])(
  'cancels each screen-owned surface for %s and leaves unrelated surfaces alone',
  async (change) => {
    let viewer: string | null = 'A';
    let epoch = 1;
    let open!: Open;
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const isCurrent = (intent: NotificationIntent) =>
      intent.viewerId === viewer && intent.epoch === epoch;
    const layers: { signal: AbortSignal; resolve: (value: string) => void }[] = [];
    const present: Present = (signal) =>
      new Promise((resolve) => {
        layers.push({ signal, resolve });
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
    const external = new AbortController();
    function Row() {
      useEffect(() => () => {}, []);
      return null;
    }
    function Screen({ showRow }: { showRow: boolean }) {
      open = useOwnedNotificationSurfaces(isCurrent, subscribe);
      return showRow ? <Row /> : null;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Screen showRow />);
    });
    const intent = { viewerId: 'A', epoch: 1 };
    let sheet!: Promise<string | undefined>;
    let menu!: Promise<string | undefined>;
    await act(async () => {
      sheet = open(intent, present);
      menu = open(intent, present);
      renderer.update(<Screen showRow={false} />);
    });
    expect(layers).toHaveLength(2);
    expect(layers.every(({ signal }) => !signal.aborted)).toBe(true);
    await act(async () => {
      if (change === 'logout') viewer = null;
      else if (change === 'ABA') viewer = 'B';
      epoch++;
      for (const listener of listeners) listener();
      if (change === 'ABA') {
        viewer = 'A';
        epoch++;
        for (const listener of listeners) listener();
      }
      await Promise.all([sheet, menu]);
    });
    expect(layers.every(({ signal }) => signal.aborted)).toBe(true);
    expect(external.signal.aborted).toBe(false);
    expect(listeners.size).toBe(0);
    await act(async () => renderer.unmount());
  },
);

it('aborts owned layers on screen unmount and rejects a stale callback afterwards', async () => {
  let open!: Open;
  const listeners = new Set<() => void>();
  function Screen() {
    open = useOwnedNotificationSurfaces(
      () => true,
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    );
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen />);
  });
  let signal!: AbortSignal;
  let result!: Promise<string | undefined>;
  const present = jest.fn(
    (next: AbortSignal) =>
      new Promise<string>((resolve) => {
        signal = next;
        next.addEventListener('abort', () => resolve('aborted'), { once: true });
      }),
  );
  await act(async () => {
    result = open({ viewerId: 'A', epoch: 1 }, present);
    renderer.unmount();
  });
  await result;
  expect(signal.aborted).toBe(true);
  expect(listeners.size).toBe(0);
  await open({ viewerId: 'A', epoch: 1 }, present);
  expect(present).toHaveBeenCalledTimes(1);
});

it('does not present when the session changes during subscription', async () => {
  let current = true;
  let open!: Open;
  let released = false;
  function Screen() {
    open = useOwnedNotificationSurfaces(
      () => current,
      (listener) => {
        current = false;
        listener();
        return () => {
          released = true;
        };
      },
    );
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen />);
  });
  const present = jest.fn(async () => 'opened');
  expect(await open({ viewerId: 'A', epoch: 1 }, present)).toBeUndefined();
  expect(present).not.toHaveBeenCalled();
  expect(released).toBe(true);
  await act(async () => renderer.unmount());
});

it('settling one owned layer does not close its sibling', async () => {
  let open!: Open;
  let current = true;
  const listeners = new Set<() => void>();
  function Screen() {
    open = useOwnedNotificationSurfaces(
      () => current,
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    );
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen />);
  });
  const layers: { signal: AbortSignal; resolve: (value: string) => void }[] = [];
  const present: Present = (signal) =>
    new Promise((resolve) => {
      layers.push({ signal, resolve });
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
  const first = open({ viewerId: 'A', epoch: 1 }, present);
  const second = open({ viewerId: 'A', epoch: 1 }, present);
  layers[0].resolve('closed');
  await first;
  expect(listeners.size).toBe(1);
  expect(layers[1].signal.aborted).toBe(false);
  current = false;
  for (const listener of listeners) listener();
  await second;
  expect(layers[1].signal.aborted).toBe(true);
  expect(listeners.size).toBe(0);
  await act(async () => renderer.unmount());
});

it('does not present from a row cleanup during screen unmount', async () => {
  const present = jest.fn(async () => 'opened');
  function Row({ open }: { open: Open }) {
    useLayoutEffect(
      () => () => {
        void open({ viewerId: 'A', epoch: 1 }, present);
      },
      [open],
    );
    return null;
  }
  function Screen() {
    const open = useOwnedNotificationSurfaces(
      () => true,
      () => () => {},
    );
    return <Row open={open} />;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen />);
  });
  await act(async () => {
    renderer.unmount();
  });
  expect(present).not.toHaveBeenCalled();
});

it('can render the owner on the server without a layout-effect warning', () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  function Screen() {
    useOwnedNotificationSurfaces(
      () => true,
      () => () => {},
    );
    return null;
  }
  try {
    expect(renderToString(<Screen />)).toBe('');
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

it('continues to own surfaces after StrictMode replays layout effects', async () => {
  let open!: Open;
  let layouts = 0;
  function Screen() {
    open = useOwnedNotificationSurfaces(
      () => true,
      () => () => {},
    );
    useLayoutEffect(() => {
      layouts++;
    }, []);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <StrictMode>
        <Screen />
      </StrictMode>,
    );
  });
  expect(layouts).toBeGreaterThanOrEqual(2);
  const present = jest.fn(async () => 'opened');
  expect(await open({ viewerId: 'A', epoch: 1 }, present)).toBe('opened');
  expect(present).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});
