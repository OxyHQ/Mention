import { describe, expect, it } from 'vitest';
import { canonicalFederationHost } from '@oxy.so/federation';
import { FEDERATION_BRIDGE_POLICY } from '../../../connectors/activitypub/federationBridgePolicy';
import {
  CROSS_NETWORK_IDENTITY_POLICY,
  findCrossNetworkPair,
  identityDomainOf,
  identityPairKey,
  participatesInCrossNetworkIdentity,
} from '../../../connectors/identityEquivalence/crossNetworkIdentityPolicy';
import { THREADS_NETWORK } from '../../../connectors/identityEquivalence/threadsNetwork';

/**
 * THE SHAPE OF THE REVIEWED PAIR LIST, ENFORCED RATHER THAN TRUSTED.
 *
 * A wrong entry here is not a mislabel, it is an account takeover: it hands one
 * person's Mention profile to whoever holds the same handle on the paired
 * network. Every property below is one an entry could plausibly get wrong while
 * still looking right in review — an un-canonical host that silently matches
 * nothing, a self-pair that would re-implement the within-network merge without
 * its guards, a missing reason nobody can audit later.
 */

describe('the cross-network identity policy', () => {
  it.each(CROSS_NETWORK_IDENTITY_POLICY.map((entry) => [entry.networks.join(' ↔ '), entry]))(
    '%s states what was verified, what is assumed, and when it was reviewed',
    (_label, entry) => {
      expect(entry.operator.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.assumption.length).toBeGreaterThan(0);
      expect(entry.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    },
  );

  it.each(CROSS_NETWORK_IDENTITY_POLICY.map((entry) => [entry.networks.join(' ↔ '), entry]))(
    '%s names two DIFFERENT canonical hosts, in sorted order',
    (_label, entry) => {
      const [a, b] = entry.networks;
      expect(a).toBe(canonicalFederationHost(a));
      expect(b).toBe(canonicalFederationHost(b));
      expect(a).not.toBe(b);
      // Sorted, so a pair is one entry rather than two orderings of one decision.
      expect([a, b]).toEqual([...entry.networks].sort());
    },
  );

  it('holds each pair exactly once, in either direction', () => {
    const keys = CROSS_NETWORK_IDENTITY_POLICY.map((entry) =>
      identityPairKey(entry.networks[0], entry.networks[1]).join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the Instagram ↔ Threads pair', () => {
  it('is reviewed, in both spellings of the question', () => {
    expect(findCrossNetworkPair('instagram.com', 'threads.net')).toBeDefined();
    expect(findCrossNetworkPair('threads.net', 'instagram.com')).toBeDefined();
    expect(findCrossNetworkPair('threads.net', 'www.instagram.com')).toBeDefined();
  });

  it('records that an Instagram handle can be released and re-registered', () => {
    expect(findCrossNetworkPair('instagram.com', 'threads.net')?.handleStability).toBe('recyclable');
  });

  /**
   * `threads.net` is native first-party ActivityPub: `acct:zuck@threads.net`
   * webfingers to a threads.net actor, so `@zuck@threads.net` is ALREADY correct
   * provenance. Registering it as a bridge would introduce a bug rather than fix
   * one — and this layer is cross-network PERSON equivalence, which is a
   * different question from bridge relabelling.
   */
  it('does not make threads.net a bridge', () => {
    expect(
      FEDERATION_BRIDGE_POLICY.some(
        (entry) => canonicalFederationHost(entry.host) === THREADS_NETWORK.domain,
      ),
    ).toBe(false);
  });
});

describe('the pairs that are deliberately absent', () => {
  it.each([
    ['two networks run by different companies', 'instagram.com', 'x.com'],
    ['a bridge HOST rather than an identity domain', 'kilogram.makeup', 'threads.net'],
    ['two networks nobody reviewed', 'mastodon.social', 'bsky.social'],
    ['a network with itself', 'instagram.com', 'instagram.com'],
  ])('refuses %s', (_label, a, b) => {
    expect(findCrossNetworkPair(a, b)).toBeUndefined();
  });
});

describe('the gate that keeps this off the hot path', () => {
  it.each(['instagram.com', 'threads.net', 'www.threads.net'])('lets %s through', (domain) => {
    expect(participatesInCrossNetworkIdentity(domain)).toBe(true);
  });

  it.each(['mastodon.social', 'x.com', 'bsky.social', 'kilogram.makeup', ''])(
    'stops %s before any query runs',
    (domain) => {
      expect(participatesInCrossNetworkIdentity(domain)).toBe(false);
    },
  );
});

describe('identityDomainOf', () => {
  it.each([
    ['zuck@instagram.com', 'instagram.com'],
    ['zuck@THREADS.NET', 'threads.net'],
    ['georgemonbiot.bsky.social@bsky.social', 'bsky.social'],
  ])('reads the domain out of %s', (identity, expected) => {
    expect(identityDomainOf(identity)).toBe(expected);
  });

  it.each([['zuck'], ['zuck@'], ['@instagram.com'], ['']])(
    'answers empty for the malformed identity %j rather than guessing',
    (identity) => {
      expect(identityDomainOf(identity)).toBe('');
    },
  );
});

describe('identityPairKey', () => {
  it('is the same row whichever side was ingested first', () => {
    expect(identityPairKey('zuck@threads.net', 'zuck@instagram.com')).toEqual(
      identityPairKey('zuck@instagram.com', 'zuck@threads.net'),
    );
  });

  it('lowercases, because an acct is case-insensitive', () => {
    expect(identityPairKey('Zuck@Instagram.com', 'ZUCK@threads.net')).toEqual([
      'zuck@instagram.com',
      'zuck@threads.net',
    ]);
  });
});
