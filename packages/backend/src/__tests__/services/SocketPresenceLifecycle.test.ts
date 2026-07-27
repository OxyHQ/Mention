import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  registerSocketPresence,
  type AuthenticatedPresenceSocket,
} from '../../services/SocketPresenceLifecycle';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeSocket extends EventEmitter {
  readonly id = 'socket-1';
  readonly user = { id: 'user-1' };
  connected = true;
  readonly join = vi.fn();

  disconnectNow(): void {
    this.connected = false;
    this.emit('disconnect', 'transport close');
  }
}

function asPresenceSocket(socket: FakeSocket): AuthenticatedPresenceSocket {
  return socket as unknown as AuthenticatedPresenceSocket;
}

describe('SocketPresenceLifecycle', () => {
  it('does not mark a socket online when it disconnects during the initial Redis lookup', async () => {
    const lookup = deferred<boolean>();
    const distributedPresence = {
      isOnline: vi.fn().mockReturnValue(lookup.promise),
      markOnline: vi.fn().mockResolvedValue(undefined),
      markOffline: vi.fn().mockResolvedValue(undefined),
    };
    const onlineUsers = new Map<string, Set<string>>();
    const broadcastPresence = vi.fn();
    const socket = new FakeSocket();

    const registration = registerSocketPresence(asPresenceSocket(socket), {
      onlineUsers,
      distributedPresence,
      broadcastPresence,
    });
    socket.disconnectNow();
    lookup.resolve(false);
    await registration;

    expect(distributedPresence.markOnline).not.toHaveBeenCalled();
    expect(distributedPresence.markOffline).not.toHaveBeenCalled();
    expect(onlineUsers).toEqual(new Map());
    expect(socket.join).not.toHaveBeenCalled();
    expect(broadcastPresence).not.toHaveBeenCalled();
  });

  it('removes a late Redis markOnline when disconnect races the refresh', async () => {
    const onlineWrite = deferred<void>();
    const distributedPresence = {
      isOnline: vi.fn().mockResolvedValue(false),
      markOnline: vi.fn().mockReturnValue(onlineWrite.promise),
      markOffline: vi.fn().mockResolvedValue(undefined),
    };
    const onlineUsers = new Map<string, Set<string>>();
    const broadcastPresence = vi.fn();
    const socket = new FakeSocket();

    const registration = registerSocketPresence(asPresenceSocket(socket), {
      onlineUsers,
      distributedPresence,
      broadcastPresence,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(distributedPresence.markOnline).toHaveBeenCalledWith('user-1');

    socket.disconnectNow();
    onlineWrite.resolve();
    await registration;

    expect(distributedPresence.markOffline).toHaveBeenCalledWith('user-1');
    expect(onlineUsers).toEqual(new Map());
    expect(socket.join).not.toHaveBeenCalled();
    expect(broadcastPresence).not.toHaveBeenCalledWith('user-1', true);
  });

  it('joins and broadcasts only after distributed presence is committed', async () => {
    const distributedPresence = {
      isOnline: vi.fn().mockResolvedValue(false),
      markOnline: vi.fn().mockResolvedValue(undefined),
      markOffline: vi.fn().mockResolvedValue(undefined),
    };
    const onlineUsers = new Map<string, Set<string>>();
    const broadcastPresence = vi.fn();
    const socket = new FakeSocket();

    await registerSocketPresence(asPresenceSocket(socket), {
      onlineUsers,
      distributedPresence,
      broadcastPresence,
    });

    expect(onlineUsers.get('user-1')).toEqual(new Set(['socket-1']));
    expect(socket.join).toHaveBeenCalledWith('user:user-1');
    expect(broadcastPresence).toHaveBeenCalledWith('user-1', true);
  });
});
