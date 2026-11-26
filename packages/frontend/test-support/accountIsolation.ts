/**
 * Fakes for the account-isolation suites: the Services runtime (a snapshot
 * published, then every subscriber woken in one pass, as Services'
 * `createOxyRuntime` does) and promises settled by hand.
 */
import type { SubjectSource } from '@/lib/accountScope';

export interface FakeRuntime extends SubjectSource {
  /** The session moves to `id` (`null`: signed out). */
  become(id: string | null): void;
}

export function createRuntime(initial: string | null): FakeRuntime {
  let snapshot: { account: { id: string } | null } = {
    account: initial ? { id: initial } : null,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    become(id) {
      snapshot = { account: id ? { id } : null };
      for (const listener of [...listeners]) listener();
    },
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
