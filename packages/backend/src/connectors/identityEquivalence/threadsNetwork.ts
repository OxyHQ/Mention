import { FEDERATION_NETWORKS, type FederationNetwork } from '@oxy.so/federation';

/**
 * `threads.net`, DECLARED THE SAME WAY EVERY OTHER NETWORK IS — and why it is
 * declared here rather than in `@oxy.so/federation`.
 *
 * `FEDERATION_NETWORKS` names the networks Oxy RE-LABELS accounts onto: X,
 * Instagram and Bluesky are all reached through something (a bridge, or the
 * atproto connector) that has to be told what the real network is. Threads needs
 * none of that. It is native first-party ActivityPub — `acct:zuck@threads.net`
 * webfingers to a threads.net actor, verified 2026-09-11 — so an actor from it
 * already arrives as `@zuck@threads.net` with correct provenance, and adding it
 * to the bridge policy would introduce a bug rather than fix one. That is why it
 * is deliberately absent from both lists, and it must stay absent from the
 * bridge one.
 *
 * What the cross-network identity layer needs is a different fact: how to
 * RECOGNISE a threads.net profile URL, so that `alsoKnownAs:
 * https://www.threads.net/@zuck` can be read as naming the identity
 * `zuck@threads.net`. That is the same declaration `FederationNetwork` already
 * carries for every other network, so it is written as one and passed to the
 * shared parser rather than hand-rolled — `federatedUsernameFromUpstreamUrl`
 * takes the network list as a parameter for exactly this reason.
 *
 * A SECOND URL PARSER IS THE FAILURE THIS AVOIDS
 *
 *   Spelling the rule inline ("strip the leading @, lowercase") would work, and
 *   would be the second place in this repository that decides what a profile URL
 *   means. The first one is read by the ingest, the search and the paste lane;
 *   a claim parsed by a different rule produces an identity string that matches
 *   no stored row, and that failure is indistinguishable from "no evidence
 *   exists" — the one shape of bug nobody reports.
 */
export const THREADS_NETWORK: FederationNetwork = {
  id: 'threads',
  name: 'Threads',
  domain: 'threads.net',
  // `canonicalFederationHost` strips a leading `www.`, so both spellings of the
  // host collapse to one — but both are listed because the canonical form is
  // what `upstreamProfileUrl` would RENDER, and `www.threads.net` is what
  // Threads itself links to.
  profileHosts: ['threads.net', 'www.threads.net'],
  profilePathPrefix: [],
  // A Threads profile URL spells the handle `@zuck`, with the sigil in the path.
  // The stored identity never carries it: `zuck@threads.net` is what an acct
  // means, and a local part containing `@` is refused outright by the shared
  // parser — correctly, since it would name a different account than it
  // addresses.
  storedUsername: (handle) => handle.trim().replace(/^@+/, '').toLowerCase(),
};

/**
 * Every network a cross-network identity claim may name.
 *
 * The shared list plus Threads. Passed wherever a claim URL is parsed, so the
 * set a claim can resolve against is stated once.
 */
export const CLAIMABLE_NETWORKS: readonly FederationNetwork[] = [
  ...Object.values(FEDERATION_NETWORKS),
  THREADS_NETWORK,
];
