import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRuntimeOxyClient,
  getRuntimeOxyClient,
  setRuntimeOxyClient,
} from '../runtime/oxyClient';
import {
  clearRuntimeSocketServer,
  getRuntimeSocketServer,
  setRuntimeSocketServer,
} from '../runtime/socketServer';

afterEach(() => {
  clearRuntimeOxyClient();
  clearRuntimeSocketServer();
});

describe('runtime service seams', () => {
  it('returns the explicitly registered Oxy client without booting the server', () => {
    const client = { getUserById: async () => ({ id: 'u1' }) };
    setRuntimeOxyClient(client as never);

    expect(getRuntimeOxyClient()).toBe(client);
  });

  it('only clears the Socket.IO server owned by the caller', () => {
    const first = { emit: () => undefined };
    const second = { emit: () => undefined };

    setRuntimeSocketServer(first as never);
    clearRuntimeSocketServer(second as never);
    expect(getRuntimeSocketServer()).toBe(first);

    clearRuntimeSocketServer(first as never);
    expect(getRuntimeSocketServer()).toBeUndefined();
  });
});
