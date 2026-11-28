import { mirrorHosts } from '../../utils/federation/mirrorTransports';

/**
 * Reviewed transports that flatten a repost into an authored `RT:` body.
 * This is a content-ingest policy only: it cannot derive accounts, rewrite
 * biographies, establish person equivalence, or choose a public profile.
 *
 * These are the same transports covered by Mention's pre-Oxy-authority RT gate;
 * retaining the list preserves content handling without retaining identity rules.
 */
export const REVIEWED_REPOST_TRANSPORT_HOSTS: readonly string[] = [
  ...mirrorHosts(),
  'bsky.brid.gy',
];
const hosts = new Set<string>(REVIEWED_REPOST_TRANSPORT_HOSTS);
export function dropsFlattenedReposts(host: string): boolean {
  return hosts.has(host.trim().toLowerCase());
}
