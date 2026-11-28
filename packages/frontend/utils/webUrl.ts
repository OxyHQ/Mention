import { WEB_BASE_URL } from '@/config';

/**
 * An absolute URL on this app's canonical web origin (`WEB_BASE_URL`), for a path
 * that starts with `/` (or `''` for the home page). Every link the app hands out
 * (share sheets, copied links, invites) is built here, so moving the canonical web
 * host is a configuration change (docs/mention-org-domain-move.md).
 */
export function webUrl(path: string): string {
  return `${WEB_BASE_URL.replace(/\/+$/, '')}${path}`;
}
