/**
 * The signed-in account of the Oxy session, for code that has to ask outside a
 * render: a continuation after an `await`, or a service.
 *
 * Services owns the session in its runtime and holds no module-level store of
 * it, so `AccountScopeFollower` hands that runtime here from inside
 * `OxyProvider`. Every answer is read from the runtime at the moment it is
 * asked; nothing is copied. Before the provider has mounted, and after it is
 * gone, there is no account, so a continuation that must prove its viewer is
 * refused.
 */

/** The part of the Services runtime this reads (`useOxyRuntime()`). */
export interface SessionRuntime {
  getSnapshot(): { account: { id?: string | null } | null };
  subscribe(listener: () => void): () => void;
}

let runtime: SessionRuntime | null = null;
const listeners = new Set<() => void>();

/** The signed-in account's id now, `null` signed out. */
export function currentAccountId(): string | null {
  return runtime?.getSnapshot().account?.id ?? null;
}

/** Called on every change of the session, an account switch included. */
export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Answer from `next` until the returned disposer runs. `onAccount` hears the
 * account held now and each one after it, from the runtime's own notification —
 * by then Services has opened that account's data store.
 */
export function followSessionRuntime(next: SessionRuntime, onAccount?: () => void): () => void {
  runtime = next;
  let held = currentAccountId();
  const unsubscribe = next.subscribe(() => {
    for (const listener of [...listeners]) listener();
    const id = currentAccountId();
    if (id === held) return;
    held = id;
    onAccount?.();
  });
  onAccount?.();
  return () => {
    unsubscribe();
    if (runtime !== next) return;
    runtime = null;
    for (const listener of [...listeners]) listener();
  };
}
