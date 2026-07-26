import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeSocketServer,
  setRuntimeSocketServer,
} from '../../runtime/socketServer';
import { emitTrendsUpdated, SOCKET_EVENTS } from '../../utils/socket';

describe('socket event helpers', () => {
  afterEach(() => {
    clearRuntimeSocketServer();
  });

  it('emits through the single late-bound runtime server', () => {
    const emit = vi.fn();
    const server = { emit } as unknown as Parameters<
      typeof setRuntimeSocketServer
    >[0];
    setRuntimeSocketServer(server);

    emitTrendsUpdated('2026-07-26T12:00:00.000Z');

    expect(emit).toHaveBeenCalledWith(SOCKET_EVENTS.TRENDS_UPDATED, {
      calculatedAt: '2026-07-26T12:00:00.000Z',
    });
  });

  it('is inert when scripts or tests have not bound Socket.IO', () => {
    expect(() => emitTrendsUpdated('2026-07-26T12:00:00.000Z')).not.toThrow();
  });
});
