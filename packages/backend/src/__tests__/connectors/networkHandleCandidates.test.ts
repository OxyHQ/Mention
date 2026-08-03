/**
 * Reading a relabelled identity BACK.
 *
 * A bridged actor is stored, rendered, searched and linked as `@elonmusk@x.com`.
 * That exact string was the one thing the resolver could not accept: pasting
 * `https://x.com/elonmusk` worked, `@elonmusk@bird.makeup` worked, and the
 * handle shown on the profile answered 404. The loop was open — we published a
 * handle we would not take back.
 *
 * It could not work by construction, which is the part worth remembering:
 * `x.com` serves no WebFinger and never will, so the ordinary connector lane has
 * nothing to ask. The identity exists only as a bridge relabel, so reading it
 * back means running the relabel backwards — the same thing a pasted profile URL
 * already does, which is why this derives the URL and reuses that lane rather
 * than growing a second rule that could drift from the first.
 */

import { networkHandleCandidates } from '../../connectors/activitypub/upstreamProfileUrl';
import { FEDERATION_BRIDGE_POLICY } from '../../connectors/activitypub/federationBridgePolicy';

describe('networkHandleCandidates', () => {
  it('derives the bridge acct for a handle on a bridged network', () => {
    const candidates = networkHandleCandidates('@elonmusk@x.com');

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].acct).toBe('elonmusk@bird.makeup');
    // The guard the caller enforces: an actor that comes back as somebody else
    // is dropped rather than shown as the account that was asked for.
    expect(candidates[0].expectedFederatedUsername).toBe('elonmusk@x.com');
  });

  it('accepts the handle with or without its leading @, and any case', () => {
    for (const query of ['@ElonMusk@X.com', 'elonmusk@x.com', '  @elonmusk@x.com  ']) {
      const [first] = networkHandleCandidates(query);
      expect(first?.acct).toBe('elonmusk@bird.makeup');
    }
  });

  /**
   * The overwhelmingly common case, and the one that must stay cheap: an
   * ordinary fediverse handle is resolvable over the protocol, so deriving a
   * bridge for it would be a wasted fetch AND a wrong answer.
   */
  it('derives nothing for a host that is not a network we bridge', () => {
    expect(networkHandleCandidates('@alice@mastodon.social')).toEqual([]);
    expect(networkHandleCandidates('@claudeai@threads.net')).toEqual([]);
  });

  it('derives nothing from a shape that is not a two-part handle', () => {
    for (const query of ['', '@', 'elonmusk', '@elonmusk', '@x.com', 'elonmusk@', '@@x.com']) {
      expect(networkHandleCandidates(query)).toEqual([]);
    }
  });

  /**
   * A local part carrying its own separator would address a different account
   * than it reads as. The refusal comes from `upstreamProfileUrlCandidates`,
   * NOT from this function — verified by mutation: deleting a duplicate check
   * here left every case green, so the check was removed rather than kept with a
   * test that appeared to guard it. The behaviour is still asserted because it
   * is the contract callers depend on; only the claim about WHERE it lives
   * changed.
   */
  it('refuses a local part that hides a separator', () => {
    expect(networkHandleCandidates('@a/b@x.com')).toEqual([]);
    expect(networkHandleCandidates('@a b@x.com')).toEqual([]);
  });

  /**
   * A `pending_dedup` bridge is committed, reviewed and deliberately inert. It
   * must not become a target here either — otherwise the search direction would
   * quietly re-enable a relabel the ingest direction refuses to make.
   */
  it('never targets a bridge whose relabel is switched off', () => {
    const inert = FEDERATION_BRIDGE_POLICY.filter((entry) => entry.relabel !== 'enabled');
    const targeted = new Set(networkHandleCandidates('@someone@x.com').map((c) => c.bridgeHost));
    for (const entry of inert) expect(targeted.has(entry.host)).toBe(false);
  });

  /**
   * Not a restatement of the derivation — a check that this lane and the pasted
   * URL lane cannot drift apart, since they are meant to be one rule read from
   * two directions. If someone changes either, this fails.
   */
  it('agrees exactly with what the pasted profile URL derives', async () => {
    const { upstreamProfileUrlCandidates } = await import('../../connectors/activitypub/upstreamProfileUrl');
    expect(networkHandleCandidates('@elonmusk@x.com'))
      .toEqual(upstreamProfileUrlCandidates('https://x.com/elonmusk'));
  });
});
