import { readPersistedViewerOwner } from '@/db';
import { initializeI18n } from '@/lib/i18n';
import { oxyServices } from '@/lib/oxyServices';
import { startBootFeedRead } from '@/services/feedPageRead';

/**
 * How long a signed-in device waits for its session before giving up on a boot
 * read. Past the SDK's own cold-boot deadline (12 s) the session is not coming,
 * and the home feed reads for itself once the viewer resolves.
 */
const SESSION_WAIT_MS = 15_000;

function accessToken(): string | null {
  try {
    return oxyServices.http.getAccessToken();
  } catch {
    return null;
  }
}

function bearerUserId(): string | null {
  try {
    return oxyServices.session.userId;
  } catch {
    return null;
  }
}

/**
 * Start the home feed's first page while the app boots, instead of when the
 * feed renders — which waits for the whole cold boot: the bundle, the root
 * providers and the viewer resolving (`AccountSwitchReset`).
 *
 * Read for the viewer this device last had (`readPersistedViewerOwner`): an
 * anonymous read when that was a signed-out visitor (or nobody), and, when it
 * was an account, a read as whoever the bearer belongs to the moment the
 * session lands. The language waits for i18n, so the request carries the same
 * `Accept-Language` the feed's own would.
 *
 * Identity-safe by construction: the read records the viewer it was made as,
 * and the feed takes it only when it resolves as that same viewer
 * (`takeBootFeedRead`); otherwise it is never shown.
 */
export function startHomeFeedBootRead(): void {
  if (typeof window === 'undefined' || window.location.pathname !== '/') return;
  const owner = readPersistedViewerOwner();
  const languageReady = initializeI18n().catch(() => undefined);

  if (!owner || owner === 'anon') {
    void languageReady.then(() => {
      // A session that landed meanwhile is not anonymous; the feed reads for it.
      if (!accessToken()) startBootFeedRead(null);
    });
    return;
  }

  let stopped = false;
  const unsubscribe = oxyServices.http.addTokenChangeListener((token) => {
    if (!token || stopped) return;
    stop();
    void languageReady.then(() => {
      const viewerId = bearerUserId();
      // Still the same bearer when the request leaves, and it names an account.
      if (viewerId && accessToken() === token) startBootFeedRead(viewerId);
    });
  });
  const timer = setTimeout(() => stop(), SESSION_WAIT_MS);
  function stop() {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  }
}
