import { StrictMode, useEffect, useLayoutEffect } from 'react';
import { renderToString } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { useOwnedNotificationSurfaces } from '../useOwnedNotificationSurfaces';
import { buildMenuGroups } from '@/components/common/actionMenuGroups';
import { OwnedSurfaceContent } from '@/components/common/OwnedSurfaceContent';
import type { NotificationIntent } from '@/types/notificationIntent';

type Present = (signal: AbortSignal, onClosed: () => void) => Promise<string>;
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
  const layers: { signal: AbortSignal; resolve: (value: string) => void; closed: () => void }[] =
    [];
  const present: Present = (signal, closed) =>
    new Promise((resolve) => {
      layers.push({ signal, resolve, closed });
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
  const first = open({ viewerId: 'A', epoch: 1 }, present);
  const second = open({ viewerId: 'A', epoch: 1 }, present);
  layers[0].resolve('closed');
  expect(await first).toBe('closed');
  expect(listeners.size).toBe(2);
  expect(layers[0].signal.aborted).toBe(false);
  expect(layers[1].signal.aborted).toBe(false);
  layers[0].closed();
  expect(listeners.size).toBe(1);
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
it('AUDIT: a mounted owned surface closes when the rendered permission gate changes', async () => {
  let open!: Open;
  let signal!: AbortSignal;
  function Screen({ allowed }: { allowed: boolean }) {
    open = useOwnedNotificationSurfaces(
      () => allowed,
      () => () => {},
    );
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen allowed />);
  });
  await act(async () => {
    void open({ viewerId: 'A', epoch: 1 }, (next) => {
      signal = next;
      return new Promise((resolve) =>
        next.addEventListener('abort', () => resolve('aborted'), { once: true }),
      );
    });
    renderer.update(<Screen allowed={false} />);
  });
  expect(signal.aborted).toBe(true);
  await act(async () => renderer.unmount());
});

it('AUDIT: a result that settles after a committed unmount must not continue', async () => {
  const events: string[] = [];
  let open!: Open;
  let complete!: (value: string) => void;
  function Screen() {
    open = useOwnedNotificationSurfaces(
      () => true,
      () => () => {},
    );
    useLayoutEffect(
      () => () => {
        events.push('layout-cleanup');
      },
      [],
    );
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen />);
  });
  let result!: Promise<string | undefined>;
  act(() => {
    result = open(
      { viewerId: 'A', epoch: 1 },
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    complete('confirmed');
    renderer.unmount();
  });
  expect(events).toEqual(['layout-cleanup']);
  expect(await result).toBeUndefined();
});

it('discards a confirmed result when the session changes before its continuation', async () => {
  let open!: Open;
  let complete!: (value: string) => void;
  let epoch = 1;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function Screen() {
    open = useOwnedNotificationSurfaces((intent) => intent.epoch === epoch, subscribe);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen />);
  });
  let result!: Promise<string | undefined>;
  await act(async () => {
    result = open(
      { viewerId: 'A', epoch: 1 },
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    complete('confirmed');
    epoch = 2;
    for (const listener of listeners) listener();
  });
  expect(await result).toBeUndefined();
  expect(listeners.size).toBe(0);
  await act(async () => renderer.unmount());
});

it('keeps an open surface through a valid refresh and releases its subscription on closure', async () => {
  let open!: Open;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function Screen({ revision }: { revision: number }) {
    open = useOwnedNotificationSurfaces((intent) => intent.epoch === 1 && revision > 0, subscribe);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen revision={1} />);
  });
  let signal!: AbortSignal;
  let complete!: (value: string) => void;
  let closed!: () => void;
  let result!: Promise<string | undefined>;
  await act(async () => {
    result = open({ viewerId: 'A', epoch: 1 }, (next, onClosed) => {
      signal = next;
      closed = onClosed;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    renderer.update(<Screen revision={2} />);
    for (const listener of listeners) listener();
  });
  expect(signal.aborted).toBe(false);
  expect(listeners.size).toBe(1);
  await act(async () => {
    complete('confirmed');
  });
  expect(await result).toBe('confirmed');
  expect(signal.aborted).toBe(false);
  expect(listeners.size).toBe(1);
  closed();
  expect(listeners.size).toBe(0);
  await act(async () => renderer.unmount());
});

it('retires the old owner when its subscription source is replaced', async () => {
  let open!: Open;
  let signal!: AbortSignal;
  const firstListeners = new Set<() => void>();
  const secondListeners = new Set<() => void>();
  const subscribeFirst = (listener: () => void) => {
    firstListeners.add(listener);
    return () => firstListeners.delete(listener);
  };
  const subscribeSecond = (listener: () => void) => {
    secondListeners.add(listener);
    return () => secondListeners.delete(listener);
  };
  function Screen({ second }: { second: boolean }) {
    open = useOwnedNotificationSurfaces(() => true, second ? subscribeSecond : subscribeFirst);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen second={false} />);
  });
  const oldOpen = open;
  let result!: Promise<string | undefined>;
  await act(async () => {
    result = oldOpen({ viewerId: 'A', epoch: 1 }, (owner) => {
      signal = owner;
      return new Promise((resolve) =>
        owner.addEventListener('abort', () => resolve('aborted'), { once: true }),
      );
    });
    renderer.update(<Screen second />);
    await Promise.resolve();
  });
  await result;
  expect(signal.aborted).toBe(true);
  expect(firstListeners.size).toBe(0);
  const present = jest.fn(async (_signal: AbortSignal, closed: () => void) => {
    closed();
    return 'opened';
  });
  expect(await oldOpen({ viewerId: 'A', epoch: 1 }, present)).toBeUndefined();
  expect(present).not.toHaveBeenCalled();
  expect(await open({ viewerId: 'A', epoch: 1 }, present)).toBe('opened');
  expect(secondListeners.size).toBe(0);
  await act(async () => renderer.unmount());
});

it('keeps a separately owned child open when its menu settles', async () => {
  let open!: Open;
  let menuSignal!: AbortSignal;
  let childSignal!: AbortSignal;
  let closeMenu!: (value: string) => void;
  const listeners = new Set<() => void>();
  let current = true;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function Screen() {
    open = useOwnedNotificationSurfaces(() => current, subscribe);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Screen />);
  });
  const intent = { viewerId: 'A', epoch: 1 };
  const menu = open(intent, (signal) => {
    menuSignal = signal;
    return new Promise((resolve) => {
      closeMenu = resolve;
    });
  });
  let child!: Promise<string | undefined>;
  const groups = buildMenuGroups(
    [
      [
        {
          label: 'Open',
          icon: null,
          onPress: () => {
            child = open(intent, (signal) => {
              childSignal = signal;
              return new Promise((resolve) =>
                signal.addEventListener('abort', () => resolve('aborted'), { once: true }),
              );
            });
          },
        },
      ],
    ],
    () => closeMenu('closed'),
    menuSignal,
  );
  await act(async () => {
    groups[0][0].onPress();
    await menu;
  });
  expect(menuSignal.aborted).toBe(false);
  expect(childSignal.aborted).toBe(false);
  current = false;
  await act(async () => {
    for (const listener of listeners) listener();
    await child;
  });
  expect(childSignal.aborted).toBe(true);
  await act(async () => renderer.unmount());
});

it('keeps ownership through exit and hides content if the session changes', async () => {
  let open!: Open;
  let signal!: AbortSignal;
  let complete!: (value: string) => void;
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
  let screen!: TestRenderer.ReactTestRenderer;
  let visualExit!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    screen = TestRenderer.create(<Screen />);
  });
  const result = open({ viewerId: 'A', epoch: 1 }, (owner) => {
    signal = owner;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  await act(async () => {
    visualExit = TestRenderer.create(
      <OwnedSurfaceContent signal={signal}>private content</OwnedSurfaceContent>,
    );
  });
  expect(visualExit.toJSON()).toBe('private content');
  await act(async () => {
    complete('confirmed');
    await result;
  });
  expect(await result).toBe('confirmed');
  expect(visualExit.toJSON()).toBe('private content');
  await act(async () => {
    current = false;
    for (const listener of listeners) listener();
  });
  expect(visualExit.toJSON()).toBeNull();
  expect(listeners.size).toBe(0);
  await act(async () => {
    screen.unmount();
    visualExit.unmount();
  });
});
