/**
 * Helpers for clearing viewer-scoped client caches when the authenticated
 * session changes. Web without SQLite uses process-local Maps for feed/post
 * reads; those caches must not survive sign-out into another local session.
 */

import { clearMemoryStore } from '@/db';

export function clearViewerSessionCache(): void {
  clearMemoryStore();
}
