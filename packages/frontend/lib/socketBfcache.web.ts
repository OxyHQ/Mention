/**
 * Web-only release of the realtime sockets while the document sits in the
 * browser's back/forward cache.
 *
 * An open WebSocket makes a whole document ineligible for that cache in Chrome,
 * which reports the refusal as `SupportPending:WebSocket`. Mention holds one open
 * at all times — the authenticated posts socket and the public trends socket
 * share a single Socket.IO Manager, and therefore a single WebSocket — so every
 * Back or Forward that crosses a document boundary rebuilds the app from scratch:
 * white flash, splash, session restore, every screen refetched. The most common
 * boundary is simply whatever page the reader was on before this one.
 *
 * `pagehide` is early enough to fix it. The browser dispatches it BEFORE deciding
 * whether the page is storable — measured in Chrome 150, which fires
 * `pagehide` with `persisted: true` and then still refuses the traversal for the
 * open WebSocket — so a socket released here is released in time to change the
 * verdict. That ordering is also what web.dev's bfcache guidance relies on.
 *
 * Native has no page lifecycle; `socketBfcache.native.ts` is a no-op.
 */

import { publicRealtimeService } from '@/services/publicRealtimeService';
import { socketService } from '@/services/socketService';

export function registerSocketBfcacheRelease(): () => void {
  const onPageHide = (event: PageTransitionEvent): void => {
    // `persisted: false` means the browser has already committed to destroying
    // this document, so there is nothing left for a released socket to buy.
    if (!event.persisted) return;
    socketService.suspendForPageFreeze();
    publicRealtimeService.suspendForPageFreeze();
  };

  const onPageShow = (event: PageTransitionEvent): void => {
    // A non-persisted `pageshow` is a fresh document booting normally, whose
    // sockets are opened by the bridges that own them. Reconnecting here would
    // open a second connection alongside the one they are about to make.
    if (!event.persisted) return;
    socketService.resumeAfterPageRestore();
    publicRealtimeService.resumeAfterPageRestore();
  };

  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  return () => {
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  };
}
