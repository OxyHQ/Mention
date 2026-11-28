import {
  PUBLIC_REALTIME_EVENTS,
  PUBLIC_REALTIME_NAMESPACE,
  type TrendsUpdatedPayload,
} from '@mention/shared-types';
import { getRuntimeSocketServer } from '../runtime/socketServer';

/**
 * Broadcast a lightweight trends-updated signal on the PUBLIC namespace.
 *
 * Trending is a public surface — a signed-out visitor sees the widget — so the
 * signal has to reach clients that have no session. Every other namespace on
 * this server is behind `oxy.authSocket()`, which an anonymous client cannot
 * pass; the public namespace exists precisely so this notice can reach them
 * without loosening any of the others. The admission rule for what may be
 * emitted here lives with the namespace definition in `@mention/shared-types`.
 *
 * The runtime seam is the single Socket.IO owner, so this stays a no-op in
 * tests/scripts that intentionally do not bind a server.
 */
export const emitTrendsUpdated = (calculatedAt: string): void => {
  const payload: TrendsUpdatedPayload = { calculatedAt };
  getRuntimeSocketServer()
    ?.of(PUBLIC_REALTIME_NAMESPACE)
    .emit(PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED, payload);
};
