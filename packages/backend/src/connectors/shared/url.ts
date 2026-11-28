/**
 * Generic, protocol-agnostic URL predicates shared across network connectors.
 *
 * These were previously private members of the monolithic federation helpers.
 * They are extracted here — rather than left in the ActivityPub-specific
 * `activitypub/helpers.ts` — so the protocol-agnostic `shared/federatedMedia.ts`
 * can use them WITHOUT depending on any ActivityPub runtime module (the whole
 * point of the shared layer: a future atproto connector reuses it too).
 */

/** True when `value` is an absolute `http(s)` URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Lowercased host of a remote URL, or `undefined` when the URL is malformed. */
export function getRemoteHost(remoteUrl: string): string | undefined {
  try {
    return new URL(remoteUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
}
