import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../utils/logger';
import { createSocketRateLimiter } from '../../middleware/socketRateLimit';

/**
 * These pin the crash-containment fix: a handler registered through `wrap`
 * used to have its return value discarded outright. A synchronous throw
 * propagated straight out of the Socket.IO emit call, and — since every
 * handler `wrap` guards is `async` — a rejection became an unhandled promise
 * rejection, which `globalErrorHandlers` treats as fatal and exits the
 * process over one malformed client message. `wrap` is now the one place
 * that contains both.
 */
describe('socketRateLimit wrap() error containment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('contains a synchronous throw without letting it escape the caller', () => {
    const { wrap } = createSocketRateLimiter();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const socket = { id: 'socket-1' };
    const handler = wrap(socket, 'someEvent', () => {
      throw new Error('boom');
    });

    expect(() => handler()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][1]).toMatchObject({ eventName: 'someEvent', socketId: 'socket-1' });
  });

  it('contains an async rejection as an unhandled-rejection sentinel would catch', async () => {
    const { wrap } = createSocketRateLimiter();
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const socket = { id: 'socket-2' };

    // The real trigger: an async handler destructuring a missing payload
    // throws during argument binding, which async-function semantics turn
    // into an already-rejected promise rather than a synchronous throw.
    const handler = wrap(socket, 'markNotificationRead', async ({ notificationId }: { notificationId?: string }) => {
      void notificationId;
    });

    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    handler(undefined as never);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });

  it('logs the failure once the returned promise settles, not before', async () => {
    const { wrap } = createSocketRateLimiter();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const socket = { id: 'socket-3' };
    const handler = wrap(socket, 'someEvent', async () => {
      throw new Error('async boom');
    });

    handler();
    expect(error).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('acks the true last argument with a bounded error when the handler fails', () => {
    const { wrap } = createSocketRateLimiter();
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const socket = { id: 'socket-4' };
    const ack = vi.fn();
    const handler = wrap(socket, 'someEvent', () => {
      throw new Error('boom with details nobody outside should see');
    });

    handler('payload', ack);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ error: 'internal_error' });
  });

  it('does not call a non-function trailing argument', () => {
    const { wrap } = createSocketRateLimiter();
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const socket = { id: 'socket-5' };
    const handler = wrap(socket, 'someEvent', () => {
      throw new Error('boom');
    });

    expect(() => handler('payload', 'not-a-function' as never)).not.toThrow();
  });

  it('leaves rate limiting behaviour unchanged for a handler that always throws', () => {
    const { wrap } = createSocketRateLimiter();
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const socket = { id: 'socket-6' };
    let calls = 0;
    // getPresenceBulk is configured for 10 events / 10s.
    const handler = wrap(socket, 'getPresenceBulk', () => {
      calls += 1;
      throw new Error('boom');
    });

    for (let i = 0; i < 15; i += 1) handler();

    expect(calls).toBe(10);
  });
});
