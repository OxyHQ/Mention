/**
 * A write started for account A never lands in account B's cache.
 *
 * Syra's and Inbox's Services 15 clients drop the cache on a switch, but a
 * mutation of the old account whose `onSuccess` (or rollback) calls
 * `setQueryData` after the switch still wrote into the new account's cache.
 * Mention's client binds every mutation to the account it started for
 * (`AccountQueryClient`), and `accountCacheWriter()` does the same for a write
 * after an `await` (an `onMutate` that cancels first, a handler).
 */
import { MutationObserver, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { followOxyRuntime, resetAccountScopeForTests } from '@/lib/accountScope';
import { accountCacheWriter, queryClient } from '@/lib/queryClient';
import { createRuntime, deferred } from '@/test-support/accountIsolation';

const KEY = ['shared-root'];

/** Lets React Query run a mutation's `onMutate`s and send its request. */
const sent = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let unfollow: () => void = () => undefined;
afterEach(() => {
  unfollow();
  queryClient.clear();
  resetAccountScopeForTests();
});

function follow(initial: string) {
  const runtime = createRuntime(initial);
  unfollow = followOxyRuntime(runtime, queryClient);
  return runtime;
}

it('runs a mutation’s onSuccess, onError and onSettled only for the account it started for', async () => {
  const runtime = follow('A');
  const answer = deferred<string>();
  const calls: string[] = [];
  const observer = new MutationObserver(queryClient, {
    mutationFn: () => answer.promise,
    onSuccess: (data: string) => {
      calls.push('success');
      queryClient.setQueryData(KEY, data);
    },
    onSettled: () => {
      calls.push('settled');
      queryClient.setQueryData(['settled'], 'A-private-settled');
    },
  });
  const done = observer.mutate().catch(() => undefined);
  await sent();

  runtime.become('B');
  queryClient.setQueryData(KEY, 'B-own');

  answer.resolve('A-private-answer');
  await done;
  expect(calls).toEqual([]);
  expect(queryClient.getQueryData(KEY)).toBe('B-own');
  expect(queryClient.getQueryData(['settled'])).toBeUndefined();
});

it('does not roll A’s snapshot back over B’s data when A’s write fails after the switch', async () => {
  const runtime = follow('A');
  queryClient.setQueryData(KEY, 'A-private-before');
  const answer = deferred<string>();
  const observer = new MutationObserver<string, Error, void, { previous: unknown }>(queryClient, {
    mutationFn: () => answer.promise,
    onMutate: () => {
      const previous = queryClient.getQueryData(KEY);
      queryClient.setQueryData(KEY, 'A-private-optimistic');
      return { previous };
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(KEY, context?.previous);
    },
  });
  const done = observer.mutate().catch(() => undefined);
  await sent();
  expect(queryClient.getQueryData(KEY)).toBe('A-private-optimistic');

  runtime.become('B');
  expect(queryClient.getQueryData(KEY)).toBeUndefined();
  queryClient.setQueryData(KEY, 'B-own');

  answer.reject(new Error('offline'));
  await done;
  expect(queryClient.getQueryData(KEY)).toBe('B-own');
});

it('keeps the guard on a pending mutation whose component re-renders with new options', async () => {
  const runtime = follow('A');
  const answer = deferred<string>();
  let start: () => void = () => undefined;
  let rerender: () => void = () => undefined;

  function Writer() {
    const [renders, setRenders] = useState(0);
    rerender = () => setRenders((count) => count + 1);
    // New callbacks every render: React Query hands them to the pending mutation.
    const mutation = useMutation({
      mutationFn: () => answer.promise,
      onSuccess: (data: string) => queryClient.setQueryData(KEY, `${data}-${renders}`),
    });
    start = () => mutation.mutate();
    return null;
  }

  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Writer />
      </QueryClientProvider>,
    );
  });
  act(() => start());
  await act(sent);
  act(() => rerender());
  act(() => runtime.become('B'));
  act(() => rerender());

  await act(async () => {
    answer.resolve('A-private-answer');
    await answer.promise;
  });
  expect(queryClient.getQueryData(KEY)).toBeUndefined();
  view.unmount();
});

it('refuses to send a write whose account was left before its request went out', async () => {
  const runtime = follow('A');
  const mutationFn = jest.fn((): Promise<string> => Promise.resolve('A-answer'));
  const onMutate = jest.fn((): void => {
    queryClient.setQueryData(KEY, 'A-private-optimistic');
  });
  const observer = new MutationObserver<string, Error, void>(queryClient, { mutationFn, onMutate });
  // React Query awaits its cache's `onMutate` before the mutation's own one
  // and before the request: the switch lands in between.
  const done = observer.mutate().catch((error: unknown) => error);
  runtime.become('B');

  expect(await done).toMatchObject({ name: 'AccountChangedError' });
  expect(mutationFn).not.toHaveBeenCalled();
  expect(onMutate).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(KEY)).toBeUndefined();
});

it('still writes a mutation’s answer while its account stays signed in', async () => {
  follow('A');
  const observer = new MutationObserver(queryClient, {
    mutationFn: () => Promise.resolve('A-answer'),
    onSuccess: (data: string) => queryClient.setQueryData(KEY, data),
  });
  await observer.mutate();
  expect(queryClient.getQueryData(KEY)).toBe('A-answer');
});

it('drops a write after an await once the account it was taken for is left', async () => {
  const runtime = follow('A');
  const write = accountCacheWriter();
  const cancelled = deferred<void>();
  const optimistic = (async () => {
    // The `onMutate` shape: cancel first, then paint.
    await cancelled.promise;
    write.setQueryData(KEY, 'A-private-optimistic');
    write.run((client) => client.setQueryData(['other'], 'A-private-other'));
  })();

  runtime.become('B');
  cancelled.resolve();
  await optimistic;
  expect(queryClient.getQueryData(KEY)).toBeUndefined();
  expect(queryClient.getQueryData(['other'])).toBeUndefined();
  expect(write.token.isCurrent()).toBe(false);

  // A writer taken for B writes.
  accountCacheWriter().setQueryData(KEY, 'B-own');
  expect(queryClient.getQueryData(KEY)).toBe('B-own');
});
