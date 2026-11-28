import type { User as OxyUser } from '@oxy.so/core';
import { externalIdentityReferenceSchema } from '@oxy.so/contracts';
import { isBlockedDomain } from './activitypub/constants';
import { domainFromAcct } from './activitypub/helpers';
import { isAbsoluteHttpUrl } from './shared/url';

/**
 * Mention's instance policy applied to a profile Oxy resolved: the connector
 * layer's answer to "may Mention show this federated account?", for product
 * code outside it (`services/accounts/profileByHandle`).
 */

function hostOf(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !isAbsoluteHttpUrl(uri)) return undefined;
  return new URL(uri).hostname.toLowerCase();
}

/**
 * Whether Mention's instance policy refuses this federated profile: its actor,
 * its origin domain, or any source identity Oxy lists for it (actor host and
 * transport acct host, as `/federation/resolve` judges a source) is on an
 * instance Mention does not federate with. A local Oxy account is never refused
 * here: it has no remote instance.
 */
export function isRefusedFederatedProfile(profile: OxyUser): boolean {
  if (!(profile.isFederated || profile.type === 'federated')) return false;
  const hosts = new Set<string>();
  const add = (host: string | undefined) => {
    if (host) hosts.add(host.toLowerCase());
  };
  add(hostOf(profile.federation?.actorUri));
  add(typeof profile.federation?.domain === 'string' ? profile.federation.domain : undefined);
  add(hostOf(profile.actorUri));
  const identities = externalIdentityReferenceSchema.array().safeParse(profile.externalIdentities);
  if (identities.success) {
    for (const identity of identities.data) {
      add(hostOf(identity.actorUri));
      add(domainFromAcct(identity.transportAcct));
    }
  }
  for (const host of hosts) if (isBlockedDomain(host)) return true;
  return false;
}
