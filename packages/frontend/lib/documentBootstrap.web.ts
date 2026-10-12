import { getNormalizedUserId, normalizeUserIdentity, type User } from '@oxy.so/core';
import { isPublicProfileHandle } from '@/utils/publicProfileHandle';

/**
 * Public data the server resolved while building this document, read from the
 * inert `<script type="application/json" id="mention-bootstrap">` it injects
 * (`packages/backend/src/services/webShellRenderer.ts`, `ShellBootstrap`).
 *
 * The document is publicly cached, so this is only ever what an anonymous
 * caller can read, and possibly a few minutes old: callers use it as a FLOOR
 * while their own request is in flight, never as the answer.
 */
interface DocumentBootstrap {
  profile?: { handle?: unknown; data?: unknown };
}

const ELEMENT_ID = 'mention-bootstrap';

let parsed: DocumentBootstrap | null | undefined;

function readBootstrap(): DocumentBootstrap | null {
  if (parsed !== undefined) return parsed;
  parsed = null;
  const element = typeof document === 'undefined' ? null : document.getElementById(ELEMENT_ID);
  if (!element?.textContent) return parsed;
  try {
    const value: unknown = JSON.parse(element.textContent);
    if (value && typeof value === 'object') parsed = value as DocumentBootstrap;
  } catch {
    // A malformed block is simply absent: the page fetches as it always did.
  }
  return parsed;
}

/**
 * The public profile this document was served for, when the route asks for the
 * same handle and the payload passes the same public-route rule the page applies
 * to a fetched profile (canonical username or an Oxy-proven alias).
 */
export function bootstrapProfileFor(handle: string): User | null {
  const profile = readBootstrap()?.profile;
  if (!profile || typeof profile.handle !== 'string') return null;
  if (profile.handle.trim().toLowerCase() !== handle.trim().replace(/^@+/, '').toLowerCase())
    return null;
  const data = profile.data;
  if (!data || typeof data !== 'object' || !getNormalizedUserId(data as User)) return null;
  const user = normalizeUserIdentity(data as User);
  return isPublicProfileHandle(handle, user.username, data) ? user : null;
}

export const __documentBootstrapForTests = {
  reset: () => {
    parsed = undefined;
  },
};
