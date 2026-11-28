import { DraftMutationQueue } from '../draftMutationQueue';

it('releases a failed mutation, cleans up the key, and lets another viewer proceed independently', async () => {
  const queue = new DraftMutationQueue();
  let reject!: (error: Error) => void;
  const first = queue.run(
    'a',
    () =>
      new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  const secondMutation = jest.fn(async () => 'second');
  const second = queue.run('a', secondMutation);
  const other = queue.run('b', async () => 'other');
  expect(await other).toBe('other');
  expect(secondMutation).not.toHaveBeenCalled();
  const failed = expect(first).rejects.toThrow('unavailable');
  reject(new Error('unavailable'));
  await failed;
  expect(await second).toBe('second');
  await Promise.resolve();
  expect(queue.size).toBe(0);
});

it('releases and cleans up after a synchronous exception', async () => {
  const queue = new DraftMutationQueue();
  const failed = queue.run('a', () => {
    throw new Error('synchronous failure');
  });
  const next = queue.run('a', async () => 'ok');
  await expect(failed).rejects.toThrow('synchronous failure');
  await expect(next).resolves.toBe('ok');
  await Promise.resolve();
  expect(queue.size).toBe(0);
});

it('runs without a cross-tab lock where the platform has none', async () => {
  const target = globalThis.navigator;
  Object.defineProperty(target, 'locks', { configurable: true, value: undefined });
  try {
    const queue = new DraftMutationQueue();
    expect(await queue.run('a', async () => 'done')).toBe('done');
    await expect(
      new DraftMutationQueue().run('a', () => {
        throw new Error('synchronous failure');
      }),
    ).rejects.toThrow('synchronous failure');
  } finally {
    delete (target as { locks?: unknown }).locks;
  }
});

it('holds a cross-tab lock for the viewer while a mutation runs', async () => {
  const held: string[] = [];
  const target = globalThis.navigator;
  Object.defineProperty(target, 'locks', {
    configurable: true,
    value: {
      request: async (name: string, callback: () => Promise<unknown>) => {
        held.push(name);
        return callback();
      },
    },
  });
  try {
    const queue = new DraftMutationQueue();
    expect(await queue.run('a', async () => 'done')).toBe('done');
    expect(held).toEqual(['mention-drafts:a']);
  } finally {
    delete (target as { locks?: unknown }).locks;
  }
});
