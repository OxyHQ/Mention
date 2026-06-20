/**
 * Global type augmentations for the Mention backend.
 *
 * The Socket.IO server instance is created in `server.ts` and exposed on the
 * Node `global` object so utility modules that emit events without access to
 * the Express `req`/`app` (e.g. notification helpers, post-creation pipeline,
 * room/follow routes) can reach it. Declaring it here gives every consumer a
 * properly typed `global.io` (and `globalThis.io`) instead of an `as any` cast.
 *
 * It is `| undefined` because emit sites can run before the server has finished
 * booting (or in unit tests where the server is never started). Consumers MUST
 * guard with `if (global.io)` before use — the type forces that null check.
 */
import type { Server as SocketIOServer } from 'socket.io';

declare global {
  // eslint-disable-next-line no-var
  var io: SocketIOServer | undefined;

  namespace Express {
    /**
     * Raw request body captured by the `express.json` `verify` hook in
     * `server.ts`. Preserved as the exact UTF-8 payload string so ActivityPub
     * inbound handlers can verify HTTP signatures and `Digest` headers against
     * the unparsed bytes. `undefined` when the request had no body.
     */
    interface Request {
      rawBody?: string;
    }
  }
}

export {};
