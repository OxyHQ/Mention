import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_REALTIME_NAMESPACE } from '@mention/shared-types';
import { Server as SocketIOServer } from 'socket.io';
import {
  createSocketIoServer,
  createSocketNamespaces,
  type SocketAuthProvider,
} from '../../runtime/socketIoServer';

/**
 * Namespace admission is the invariant worth pinning here: the public realtime
 * namespace is the ONE namespace with no auth middleware, and every other
 * namespace — including the main one — must be behind Oxy's socket auth.
 */

const servers: Array<{ io: SocketIOServer; http: http.Server }> = [];

function createServers(): SocketIOServer {
  const httpServer = http.createServer();
  const io = createSocketIoServer(httpServer);
  servers.push({ io, http: httpServer });
  return io;
}

function createAuthProvider(): SocketAuthProvider & { authSocket: ReturnType<typeof vi.fn> } {
  const middleware = vi.fn().mockResolvedValue(undefined);
  return { authSocket: vi.fn().mockReturnValue(middleware) };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (entry) =>
        new Promise<void>((resolve) => {
          entry.io.close(() => {
            entry.http.close(() => resolve());
          });
        }),
    ),
  );
});

describe('createSocketIoServer', () => {
  it('serves on the /socket.io path with both transports', () => {
    const io = createServers();

    expect(io.path()).toBe('/socket.io');
    expect(io.engine.opts.transports).toEqual(['websocket', 'polling']);
  });

  it('accepts an allowed origin and refuses an unknown one without erroring', async () => {
    const io = createServers();
    const corsOrigin = io.engine.opts.cors?.origin;
    expect(typeof corsOrigin).toBe('function');

    const decide = (origin: string | undefined) =>
      new Promise<boolean | string>((resolve, reject) => {
        if (typeof corsOrigin !== 'function') {
          reject(new Error('cors origin is not a callback'));
          return;
        }
        corsOrigin(origin, (error, allowed) => {
          if (error) reject(error);
          else resolve(allowed ?? false);
        });
      });

    // A request with no Origin header (same-origin, curl, native app) is allowed.
    await expect(decide(undefined)).resolves.toBe(true);
    await expect(decide('https://attacker.example')).resolves.toBe(false);
  });
});

describe('createSocketNamespaces', () => {
  it('applies Oxy socket auth to notifications, posts and the main namespace', () => {
    const io = createServers();
    const oxy = createAuthProvider();

    const notifications = io.of('/notifications');
    const posts = io.of('/posts');
    const notificationsUse = vi.spyOn(notifications, 'use');
    const postsUse = vi.spyOn(posts, 'use');
    const mainUse = vi.spyOn(io, 'use');

    const namespaces = createSocketNamespaces(io, oxy);

    expect(oxy.authSocket).toHaveBeenCalledTimes(1);
    const middleware = oxy.authSocket.mock.results[0].value;
    expect(notificationsUse).toHaveBeenCalledWith(middleware);
    expect(postsUse).toHaveBeenCalledWith(middleware);
    expect(mainUse).toHaveBeenCalledWith(middleware);
    expect(namespaces.notificationsNamespace).toBe(notifications);
    expect(namespaces.postsNamespace).toBe(posts);
  });

  it('leaves the public realtime namespace unauthenticated, by design', () => {
    const io = createServers();
    const oxy = createAuthProvider();

    const publicNamespace = io.of(PUBLIC_REALTIME_NAMESPACE);
    const publicUse = vi.spyOn(publicNamespace, 'use');

    const namespaces = createSocketNamespaces(io, oxy);

    expect(publicUse).not.toHaveBeenCalled();
    expect(namespaces.publicNamespace).toBe(publicNamespace);
  });
});
