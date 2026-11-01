import { NotificationSurfaceOwner } from '../notificationSurfaceOwner';

const intent = { viewerId: 'A', epoch: 1 };
function fixture() {
  let epoch = 1;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const isCurrent = (candidate: typeof intent) =>
    candidate.viewerId === 'A' && candidate.epoch === epoch;
  const owner = new NotificationSurfaceOwner(isCurrent, subscribe);
  owner.activate();
  return {
    owner,
    listeners,
    subscribe,
    isCurrent,
    setEpoch(next: number) {
      epoch = next;
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

it('keeps the subscription through exit after returning the chosen result', async () => {
  const f = fixture();
  let signal!: AbortSignal;
  let closed!: () => void;
  const result = f.owner.open(intent, async (ownerSignal, onClosed) => {
    signal = ownerSignal;
    closed = onClosed;
    return 'confirmed';
  });
  expect(await result).toBe('confirmed');
  expect(signal.aborted).toBe(false);
  expect(f.listeners.size).toBe(1);
  f.setEpoch(2);
  f.notify();
  expect(signal.aborted).toBe(true);
  expect(f.listeners.size).toBe(0);
  closed();
  expect(await result).toBe('confirmed');
});

it('preserves a normal exit and releases exactly once when physically closed', async () => {
  const f = fixture();
  let signal!: AbortSignal;
  let closed!: () => void;
  expect(
    await f.owner.open(intent, async (ownerSignal, onClosed) => {
      signal = ownerSignal;
      closed = onClosed;
      return 'confirmed';
    }),
  ).toBe('confirmed');
  expect(f.listeners.size).toBe(1);
  closed();
  closed();
  expect(signal.aborted).toBe(false);
  expect(f.listeners.size).toBe(0);
  f.setEpoch(2);
  f.notify();
  expect(signal.aborted).toBe(false);
});

it('handles physical closure before the caller observes a result', async () => {
  const f = fixture();
  const pending = deferred<string>();
  const result = f.owner.open(intent, (_signal, closed) => {
    closed();
    return pending.promise;
  });
  expect(f.listeners.size).toBe(0);
  pending.resolve('confirmed');
  expect(await result).toBe('confirmed');
});

it('discards a result if the session changes before continuation', async () => {
  const f = fixture();
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const result = f.owner.open(intent, (ownerSignal) => {
    signal = ownerSignal;
    return pending.promise;
  });
  pending.resolve('confirmed');
  f.setEpoch(2);
  f.notify();
  expect(await result).toBeUndefined();
  expect(signal.aborted).toBe(true);
  expect(f.listeners.size).toBe(0);
});

it('aborts owned entries on disposal without touching a sibling owner', async () => {
  const f = fixture();
  const sibling = fixture();
  let signal!: AbortSignal;
  let otherSignal!: AbortSignal;
  const result = f.owner.open(intent, async (ownerSignal) => {
    signal = ownerSignal;
    return 'closed';
  });
  const other = sibling.owner.open(intent, async (ownerSignal) => {
    otherSignal = ownerSignal;
    return 'other';
  });
  expect(await result).toBe('closed');
  expect(await other).toBe('other');
  f.owner.dispose();
  expect(signal.aborted).toBe(true);
  expect(otherSignal.aborted).toBe(false);
  expect(f.listeners.size).toBe(0);
  sibling.owner.dispose();
});

it('keeps a valid refresh open and aborts when the committed predicate changes', async () => {
  const f = fixture();
  let signal!: AbortSignal;
  const result = f.owner.open(intent, async (ownerSignal) => {
    signal = ownerSignal;
    return 'selected';
  });
  expect(await result).toBe('selected');
  f.notify();
  f.owner.update((candidate) => f.isCurrent(candidate), f.subscribe);
  expect(signal.aborted).toBe(false);
  f.owner.update(() => false, f.subscribe);
  expect(signal.aborted).toBe(true);
  expect(f.listeners.size).toBe(0);
});

it('releases an immediately invalidated subscription without presenting', async () => {
  let current = true;
  let unsubscriptions = 0;
  const owner = new NotificationSurfaceOwner(
    () => current,
    (listener) => {
      current = false;
      listener();
      return () => {
        unsubscriptions++;
      };
    },
  );
  owner.activate();
  const present = jest.fn(async () => 'opened');
  expect(await owner.open(intent, present)).toBeUndefined();
  expect(present).not.toHaveBeenCalled();
  expect(unsubscriptions).toBe(1);
});

it('cleans up when presentation rejects', async () => {
  const f = fixture();
  let signal!: AbortSignal;
  const result = f.owner.open(intent, async (ownerSignal) => {
    signal = ownerSignal;
    throw new Error('presentation failed');
  });
  await expect(result).rejects.toThrow('presentation failed');
  expect(signal.aborted).toBe(true);
  expect(f.listeners.size).toBe(0);
});

it('handles disposal before continuation and can be reactivated for StrictMode', async () => {
  const f = fixture();
  const pending = deferred<string>();
  const result = f.owner.open(intent, () => pending.promise);
  pending.resolve('confirmed');
  f.owner.dispose();
  expect(await result).toBeUndefined();
  expect(f.listeners.size).toBe(0);
  f.owner.activate();
  let closed!: () => void;
  expect(
    await f.owner.open(intent, async (_signal, onClosed) => {
      closed = onClosed;
      return 'opened';
    }),
  ).toBe('opened');
  closed();
  expect(f.listeners.size).toBe(0);
});

it('rejects a late result after physical closure and a later session boundary', async () => {
  const f = fixture();
  const pending = deferred<string>();
  const result = f.owner.open(intent, (_signal, onClosed) => {
    onClosed();
    return pending.promise;
  });
  expect(f.listeners.size).toBe(0);
  f.setEpoch(2);
  pending.resolve('confirmed');
  expect(await result).toBeUndefined();
});

it('retires the old source without aborting surfaces of the new source', async () => {
  const f = fixture();
  let oldSignal!: AbortSignal;
  expect(
    await f.owner.open(intent, async (signal) => {
      oldSignal = signal;
      return 'old';
    }),
  ).toBe('old');
  const next = new Set<() => void>();
  const subscribeNext = (listener: () => void) => {
    next.add(listener);
    return () => next.delete(listener);
  };
  f.owner.update(f.isCurrent, subscribeNext);
  expect(oldSignal.aborted).toBe(true);
  expect(f.listeners.size).toBe(0);
  let newSignal!: AbortSignal;
  let closed!: () => void;
  expect(
    await f.owner.open(intent, async (signal, onClosed) => {
      newSignal = signal;
      closed = onClosed;
      return 'new';
    }),
  ).toBe('new');
  expect(newSignal.aborted).toBe(false);
  expect(next.size).toBe(1);
  closed();
  expect(next.size).toBe(0);
});
