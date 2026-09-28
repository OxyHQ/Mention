/**
 * The network an actor's IDENTITY belongs to, which is not always the host the
 * actor was fetched from.
 *
 * A re-labelled bridge actor is stored under its upstream network — its
 * `networkAcct` reads `pabloiglesias@x.com` while `domain` still reads
 * `mastox.eu`, because everything that ADDRESSES the actor over the protocol
 * stays pointed at the bridge. A handle that actor typed means the account on
 * `x.com`, so that is the domain to qualify with; using `domain` would qualify
 * it onto the hostname a copy happened to arrive through.
 *
 * ONLY a re-labelled actor gets an answer. `networkAcct` caches Oxy's
 * `canonicalAcct`, which Oxy returns for EVERY source, so its presence is not
 * the discriminator: the answer is given only when its domain differs from the
 * transport `domain`. An ordinary instance's `@alice` ALREADY means alice on
 * that instance and already resolves, so qualifying it would lengthen the text
 * of every federated post to say what a reader could already act on. A bridged
 * `@Julio_Rodr_` does not resolve at all until it carries its network.
 *
 * Typed STRUCTURALLY rather than off a row type, because callers hand this an
 * actor from more than one shape and they spell absence differently — a Drizzle
 * row carries `null` where a plain object omits the field entirely.
 */
export function identityDomainOfActor(
  actor: { networkAcct?: string | null; domain?: string | null } | null | undefined,
): string | undefined {
  const networkAcct = actor?.networkAcct?.trim();
  if (networkAcct) {
    const atIndex = networkAcct.lastIndexOf('@');
    // A `networkAcct` with no `@`, or ending in one, is malformed; fall through
    // rather than qualify handles onto an empty domain.
    if (atIndex > 0 && atIndex < networkAcct.length - 1) {
      const networkDomain = networkAcct.slice(atIndex + 1).toLowerCase();
      // Oxy's canonical network IS the transport host: an ordinary actor, not
      // a relabel. Its bare handles already resolve where they were written.
      if (networkDomain === actor?.domain?.trim().toLowerCase()) return undefined;
      return networkDomain;
    }
  }
  // Deliberately NOT falling back to `domain`. That fallback would make this
  // answer for every ordinary federated actor too — measured against production
  // before removing it: 1,266 of 5,000 sampled posts would have been rewritten,
  // and the samples were ordinary Finnish and Dutch Mastodon posts, not bridge
  // content.
  return undefined;
}
