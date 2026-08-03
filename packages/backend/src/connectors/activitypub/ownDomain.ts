import { registrableApex } from '@oxyhq/core';
import { config } from '../../config';

/**
 * WHICH HOSTS PUBLISH OUR OWN USERS.
 *
 * This is a CONFIGURATION fact, and it is deliberately not the same question as
 * `isBlockedDomain` in {@link ./constants}, which answers "should federation
 * refuse this host" and is true for our own hosts AND for every moderation
 * block. That conflation is correct where it is used — an actor fetch must
 * refuse both — but it is wrong for IDENTITY resolution, where the two answers
 * diverge completely: a URL on one of OUR hosts names a user we resolve through
 * Oxy, while a URL on a blocked instance names a user we resolve not at all.
 * Asking the blocked-domain gate to stand in for "ours" made a composed link to
 * `https://<blocked-instance>/@alice` ask Oxy to resolve `alice` as one of our
 * own users.
 *
 * So the set lives here, on its own, with its own consumers (identity
 * resolution and the own-domain purge scripts) — the two questions cannot be
 * confused for one another when they are not the same symbol.
 */

/**
 * Oxy's identity apex — the anchor domain of the DID layer. Every Oxy/Mention
 * user is ALSO published as `acct:<username>@<apex>` (e.g. `acct:alice@oxy.so`),
 * so an actor on this apex is one of OUR OWN users, never a remote federated
 * source. Treating it as remote makes `ActorService.fetchRemoteActor` create
 * duplicate `FederatedActor` rows for local users and call Oxy
 * `PUT /users/resolve` against the platform's own identities — hence it is also
 * folded into `isBlockedDomain`.
 *
 * Derived from the Oxy API URL's registrable domain via the Public Suffix List
 * (`https://api.oxy.so` → `oxy.so`); overridable with `OXY_IDENTITY_APEX` for
 * non-production anchors. The trailing literal is only reached if the API URL is
 * malformed (no registrable domain) and no override is set.
 */
const oxyApiHost = (() => {
  try {
    return new URL(config.oxyApiUrl).hostname;
  } catch {
    return config.oxyApiUrl;
  }
})();
export const OXY_IDENTITY_APEX = (
  config.federation.oxyIdentityApex
  || registrableApex(oxyApiHost)
  || 'oxy.so'
).toLowerCase();

/**
 * Every host that is US: the federation domain, the actor domain, and the Oxy
 * identity apex. A profile URL on any of them names one of our own users.
 *
 * Read straight from `config` rather than from {@link ./constants}'s exported
 * constants, because it is the same configuration and this module is a level
 * BELOW that one — `constants` imports the apex from here to build its domain
 * policy, so the arrow cannot point the other way.
 *
 * Shaped as a LIST rather than as a predicate because that is what its callers
 * take: `ownProfileUrlHandle(url, hosts)` (the handle a URL names IF the URL is
 * one of ours — gate included, percent-decoded for the profile route it will be
 * resolved against) and `buildBlockedContentDomains(blocked, ours, …)` (which
 * subtracts us, so an operator cannot blocklist us into purging our own users).
 * Both used to assemble the three-element list themselves; a second opinion
 * about which hosts are ours is exactly what this module exists to prevent.
 *
 * NOT to be merged with `PostHydrationService`'s own `OWN_PROFILE_HOSTS`, which
 * deliberately OMITS the apex. That list answers a different question — "is this
 * URL a profile page on the site the reader is browsing", which decides whether
 * a link loses its preview card — and it is held in lockstep with the frontend
 * linkifier's list, derived from the app's web base URL. Nobody browses a
 * profile at the identity apex, so adding it there would withhold a card the
 * renderer still shows a link for.
 */
export const OWN_DOMAINS: readonly string[] = [
  config.federation.domain,
  config.federation.actorDomain,
  OXY_IDENTITY_APEX,
];
