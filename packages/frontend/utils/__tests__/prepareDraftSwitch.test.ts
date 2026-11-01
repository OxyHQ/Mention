import {
  DraftReadError,
  prepareDraftSwitch,
  shouldPreservePublishedEditor,
} from '../prepareDraftSwitch';
import type { ComposeDraftRefs } from '@/hooks/useDraftManager';
import type { Draft } from '@/hooks/useDrafts';
const snapshot = (text: string, id = 'a') =>
  ({
    postContent: text,
    currentDraftId: id,
    threadItems: [],
    mentions: [],
  }) as unknown as ComposeDraftRefs;
const target = { id: 'b', postContent: 'latest B' } as Draft;
const session = {};
const getSession = () => session;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
it('saves once and reads current B when only the generated ID changed', async () => {
  const original = snapshot('A');
  let current = original;
  const d = deferred<void>();
  const save = jest.fn(() => d.promise),
    read = jest.fn(async () => target);
  const result = prepareDraftSwitch(
    'b',
    () => current,
    getSession,
    save,
    read,
    () => true,
  );
  current = { ...original, currentDraftId: 'new-id' };
  d.resolve();
  await expect(result).resolves.toEqual({ status: 'ready', draft: target });
  expect(save).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('b');
});
it.each(['edited', ''])(
  'does not switch after content changes to %j while saving',
  async (text) => {
    const original = snapshot('A');
    let current = original;
    const d = deferred<void>();
    const read = jest.fn(async () => target);
    const result = prepareDraftSwitch(
      'b',
      () => current,
      getSession,
      () => d.promise,
      read,
      () => true,
    );
    current = { ...original, postContent: text };
    d.resolve();
    await expect(result).resolves.toEqual({ status: 'changed' });
    expect(read).not.toHaveBeenCalled();
  },
);
it('does not switch if A changes while B is being read', async () => {
  const original = snapshot('A');
  let current = original;
  const started = deferred<void>(),
    d = deferred<Draft | undefined>();
  const result = prepareDraftSwitch(
    'b',
    () => current,
    getSession,
    async () => {},
    () => {
      started.resolve();
      return d.promise;
    },
    () => true,
  );
  await started.promise;
  current = { ...original, postContent: 'new A' };
  d.resolve(target);
  await expect(result).resolves.toEqual({ status: 'changed' });
});
it.each(['sheet closed', 'composer unmounted'])('cancels after %s while waiting', async () => {
  let active = true;
  const d = deferred<void>();
  const result = prepareDraftSwitch(
    'b',
    () => snapshot('A'),
    getSession,
    () => d.promise,
    async () => target,
    () => active,
  );
  active = false;
  d.resolve();
  await expect(result).resolves.toEqual({ status: 'cancelled' });
});
it('does not reload an old copy of the current draft', async () => {
  const save = jest.fn(),
    read = jest.fn();
  await expect(
    prepareDraftSwitch(
      'a',
      () => snapshot('A'),
      getSession,
      save,
      read,
      () => true,
    ),
  ).resolves.toEqual({ status: 'same' });
  expect(save).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it('reports missing B without replacing A', async () => {
  const current = snapshot('A');
  await expect(
    prepareDraftSwitch(
      'b',
      () => current,
      getSession,
      async () => {},
      async () => undefined,
      () => true,
    ),
  ).resolves.toEqual({ status: 'missing' });
});
it('propagates save failure and distinguishes target-read failure', async () => {
  const failure = new Error('storage full');
  const current = snapshot('A');
  await expect(
    prepareDraftSwitch(
      'b',
      () => current,
      getSession,
      async () => {
        throw failure;
      },
      async () => target,
      () => true,
    ),
  ).rejects.toBe(failure);
  await expect(
    prepareDraftSwitch(
      'b',
      () => current,
      getSession,
      async () => {},
      async () => {
        throw failure;
      },
      () => true,
    ),
  ).rejects.toBeInstanceOf(DraftReadError);
});
it('does not open B if the active session changed during the save', async () => {
  let activeSession = {};
  const current = snapshot('A'),
    d = deferred<void>();
  const result = prepareDraftSwitch(
    'b',
    () => current,
    () => activeSession,
    () => d.promise,
    async () => target,
    () => true,
  );
  activeSession = {};
  d.resolve();
  await expect(result).resolves.toEqual({ status: 'changed' });
});

it('preserves the editor only for work the publish did not take', () => {
  const submitted = snapshot('A');
  const session = {};
  expect(shouldPreservePublishedEditor(submitted, submitted, session, session, true)).toBe(true);
  expect(shouldPreservePublishedEditor(submitted, submitted, session, session, false)).toBe(false);
  expect(
    shouldPreservePublishedEditor(
      submitted,
      { ...submitted, postContent: 'later edit' },
      session,
      session,
      false,
    ),
  ).toBe(true);
  expect(shouldPreservePublishedEditor(submitted, submitted, session, {}, false)).toBe(true);
});
