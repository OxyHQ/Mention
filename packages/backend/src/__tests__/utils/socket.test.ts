import {
  PUBLIC_REALTIME_EVENTS,
  PUBLIC_REALTIME_NAMESPACE,
} from '@mention/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeSocketServer,
  setRuntimeSocketServer,
} from '../../runtime/socketServer';
import { emitTrendsUpdated } from '../../utils/socket';

describe('socket event helpers', () => {
  afterEach(() => {
    clearRuntimeSocketServer();
  });

  it('emits on the PUBLIC namespace so signed-out visitors get the push', () => {
    // Trending is a public surface. Emitting on the default (authenticated)
    // namespace would reach only signed-in clients and leave everyone else on
    // the slow safety-net poll.
    const emit = vi.fn();
    const of = vi.fn().mockReturnValue({ emit });
    const server = { of } as unknown as Parameters<
      typeof setRuntimeSocketServer
    >[0];
    setRuntimeSocketServer(server);

    emitTrendsUpdated('2026-07-26T12:00:00.000Z');

    expect(of).toHaveBeenCalledWith(PUBLIC_REALTIME_NAMESPACE);
    expect(emit).toHaveBeenCalledWith(PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED, {
      calculatedAt: '2026-07-26T12:00:00.000Z',
    });
  });

  it('is inert when scripts or tests have not bound Socket.IO', () => {
    expect(() => emitTrendsUpdated('2026-07-26T12:00:00.000Z')).not.toThrow();
  });
});
