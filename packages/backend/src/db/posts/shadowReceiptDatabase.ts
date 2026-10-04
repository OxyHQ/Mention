import { createDatabase } from '@oxy.so/db';
import { config } from '../../config';
import type { Database } from '../postgres';
import * as schema from '../schema';

export interface ShadowReceiptDatabase {
  readonly db: Database;
  readonly signal: AbortSignal;
  check(): void;
}

/**
 * One private, cancellable connection per maintenance cycle. Aborting closes its
 * socket, including connection acquisition and queued statements, without
 * cancelling the ordinary classifier's pool. A transaction cannot resume a
 * late UPDATE after the budget expires. Server timeouts also bound lock waits.
 */
export async function withShadowReceiptDatabase<T>(
  deadline: number,
  externalSignal: AbortSignal | undefined,
  work: (context: ShadowReceiptDatabase) => Promise<T>,
): Promise<T> {
  externalSignal?.throwIfAborted();
  const databaseUrl = config.postgres.url;
  if (!databaseUrl) throw new Error('PostgreSQL is not configured');
  const remaining = Math.ceil(deadline - Date.now());
  if (remaining <= 0 || !Number.isSafeInteger(remaining)) throw new Error('Receipt maintenance deadline expired');
  const timer = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, timer.signal]) : timer.signal;
  const { db, client } = createDatabase({ databaseUrl, schema,
    client: { max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: Math.max(1, Math.ceil(remaining / 1000)),
      connection: { application_name: 'mention-shadow-receipt-maintenance',
        statement_timeout: remaining, lock_timeout: remaining },
      onnotice: () => undefined,
    },
  });
  const timeout = setTimeout(() => timer.abort(new DOMException('Receipt maintenance deadline expired', 'TimeoutError')), remaining);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= client.end({ timeout: 0 });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { void close().catch(() => undefined); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Receipt maintenance deadline expired');
  };
  try {
    const value = await Promise.race([Promise.resolve().then(() => { check(); return work({ db, signal, check }); }), aborted]);
    check();
    return value;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    await close();
  }
}
