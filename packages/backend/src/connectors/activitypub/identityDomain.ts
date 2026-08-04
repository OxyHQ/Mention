import type { IFederatedActor } from '../../models/FederatedActor';

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
 * Falls back to the stored `domain` for every ordinary actor, where the two are
 * the same thing, and to `undefined` when neither is known — which leaves the
 * body untouched rather than qualifying onto a guess.
 */
export function identityDomainOfActor(
  actor: Pick<IFederatedActor, 'networkAcct' | 'domain'> | null | undefined,
): string | undefined {
  const networkAcct = actor?.networkAcct?.trim();
  if (networkAcct) {
    const atIndex = networkAcct.lastIndexOf('@');
    // A `networkAcct` with no `@`, or ending in one, is malformed; fall through
    // rather than qualify handles onto an empty domain.
    if (atIndex > 0 && atIndex < networkAcct.length - 1) {
      return networkAcct.slice(atIndex + 1).toLowerCase();
    }
  }
  const domain = actor?.domain?.trim();
  return domain ? domain.toLowerCase() : undefined;
}
