import {
  FEDERATION_NETWORKS,
  blueskyUsernameFromHandle,
  parseUpstreamProfileUrl,
  type FederationBridgeEntry,
  type FederationNetwork,
} from '@oxyhq/federation';
import { FEDERATION_BRIDGE_POLICY } from './federationBridgePolicy';

/**
 * A PASTED PROFILE LINK, TURNED INTO SOMETHING WE CAN ACTUALLY LOOK UP.
 *
 * Somebody pastes `https://x.com/elonmusk` into search. We can read that URL —
 * it names one account on one network — but there is nothing to search FOR: the
 * only rows we hold for X accounts arrived through a bridge, and only ever
 * because something already pulled them in. Nobody had pulled this one in, so
 * the search matched nothing and the paste looked broken.
 *
 * What is missing is the step between "which account is this" and "where can we
 * reach it": the bridges in `./federationBridgePolicy` republish exactly these
 * networks, and a bridge names a mirrored account after the account it mirrors,
 * so `elonmusk` on X is reachable as `@elonmusk@bird.makeup`. This module makes
 * that one derivation, from the SAME reviewed entries the relabeller reads
 * backwards — nothing here names a host of its own.
 *
 * WE NEVER FETCH THE PASTED URL. NOT ONCE, NOT TO CHECK IT EXISTS.
 *
 *   The URL is user input, so fetching it is a request an attacker chooses the
 *   destination of. {@link parseUpstreamProfileUrl} is purely syntactic and the
 *   only hosts we go on to contact are bridge hosts read out of our own
 *   committed policy. That is why the derivation is a lookup KEY rather than a
 *   verification: the pasted URL is a claim, and the only thing we do with a
 *   claim is decide which of our own trusted hosts to ask about it.
 *
 * A CANDIDATE IS A GUESS. THE IDENTITY IS STILL THE BRIDGE ENTRY'S DECISION.
 *
 *   `<handle>@<bridge-host>` rests on the bridge naming a mirror after its
 *   upstream account, which is a property of each bridge's software rather than
 *   something the actor asserts. A wrong guess resolves to a DIFFERENT account —
 *   `@admin@mastox.eu` is the operator, not `admin` on X — so a candidate carries
 *   the identity the ingested actor must turn out to have
 *   ({@link UpstreamProfileUrlCandidate.expectedFederatedUsername}), and the
 *   caller drops anything that does not match. Attribution stays where the policy
 *   file put it: derived per-actor, from what the actor itself publishes.
 */

/** One bridge to ask about a pasted profile URL, and what would count as an answer. */
export interface UpstreamProfileUrlCandidate {
  /** The bridge acct to resolve (`elonmusk@bird.makeup`). */
  readonly acct: string;
  /** The bridge host this candidate addresses — for diagnostics when it misses. */
  readonly bridgeHost: string;
  /**
   * The identity the ingested actor MUST derive for this candidate to be the
   * account that was pasted. Anything else is a different account reached by a
   * wrong guess, or an actor the bridge's rule did not relabel at all.
   */
  readonly expectedFederatedUsername: string;
}

/**
 * The username a handle is stored under once it is on `network`.
 *
 * Every network but one stores the handle verbatim. Bluesky's is a whole DNS
 * name, so the `.bsky.social` of a default handle is already carried by the
 * instance domain and is dropped — the rule is
 * {@link blueskyUsernameFromHandle}, shared with the atproto connector and with
 * the Bridgy Fed entry, because the same account arriving by two protocols has
 * to produce one username. Calling it here rather than restating it is what
 * keeps this third caller from becoming the one that drifts.
 */
function storedUsername(network: FederationNetwork, handle: string): string {
  return network.id === FEDERATION_NETWORKS.bluesky.id
    ? blueskyUsernameFromHandle(handle)
    : handle;
}

/**
 * The bridges to ask about a pasted upstream profile URL, in policy order, or an
 * empty list when the URL is not one we recognise (the overwhelmingly common
 * case — every other query shape, and every other host, lands here).
 *
 * Ordering is the committed order of `FEDERATION_BRIDGE_POLICY`, not a ranking
 * invented here: two bridges can mirror one network, and which of them we hold a
 * copy from is a moderation judgement that already has a reviewed home. It does
 * not change WHO the reader ends up following either way — `resolveFederatedActorIdentity`
 * collapses copies of the same upstream person onto one Oxy identity, so a second
 * bridge's copy ingested later adopts the identity the first one resolved to.
 *
 * A `pending_dedup` entry is deliberately not a target. Its relabel is inert by
 * review decision, so an actor ingested through it would be stored under the
 * BRIDGE identity — the twin that state exists to avoid, and never the account
 * that was pasted.
 *
 * `entries` is a parameter so the derivation can be exercised against a policy
 * other than the committed one; production always uses the committed one.
 */
export function upstreamProfileUrlCandidates(
  raw: string,
  entries: readonly FederationBridgeEntry[] = FEDERATION_BRIDGE_POLICY,
): UpstreamProfileUrlCandidate[] {
  const parsed = parseUpstreamProfileUrl(raw);
  if (!parsed) return [];

  const handle = parsed.handle.trim();
  // The same shapes the relabeller refuses to build an identity from. A path
  // segment is percent-decoded, so `%40` and `%2F` can put an `@` or a `/` inside
  // what looks like a handle — and either one produces an acct that addresses
  // something other than it reads as.
  if (handle.length === 0 || /[@/\s]/.test(handle)) return [];

  const expectedFederatedUsername =
    `${storedUsername(parsed.network, handle)}@${parsed.network.domain}`.toLowerCase();

  return entries
    .filter((entry) => entry.network.id === parsed.network.id && entry.relabel === 'enabled')
    .map((entry) => ({
      acct: `${handle.toLowerCase()}@${entry.host.toLowerCase()}`,
      bridgeHost: entry.host,
      expectedFederatedUsername,
    }));
}
