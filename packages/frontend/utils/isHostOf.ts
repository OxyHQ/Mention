/**
 * Whether `host` is `domain` itself or one of its subdomains.
 *
 * A bare `host.endsWith(domain)` also accepts lookalikes — `notspotify.com` ends
 * with `spotify.com` — so the suffix has to start at a label boundary.
 * Both arguments are hostnames (no scheme, port or path), compared as given.
 */
export function isHostOf(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
