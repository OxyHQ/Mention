import { describe, expect, it } from 'vitest';
import {
  FEDERATION_NETWORKS,
  upstreamProfileUrl,
  type FederationBridgeEntry,
  type NetworkIdentityCandidate,
} from '@oxyhq/federation';

/**
 * Turning a pasted profile link into bridge accts we can actually look up.
 *
 * The load-bearing assertion is the round trip against the SAME captured actors
 * the bridge entries are reviewed against: for every real bridged actor we hold,
 * the URL a reader would paste for that account must derive the acct that actor
 * is stored under, and must demand the identity that actor genuinely re-labels
 * to. Both ends come from real data — one from the actor row, one from the
 * network's own profile-URL rule — so neither can be quietly written to agree
 * with the other.
 *
 * The other half is what must NOT be derived, since a wrong candidate is a
 * request sent to a bridge about somebody else's account: an unlisted host, an
 * entry whose relabel is deliberately inert, and a "handle" that percent-decodes
 * into something that addresses differently than it reads.
 */

import {
  federationBridges,
  FEDERATION_BRIDGE_POLICY,
} from '../../../connectors/activitypub/federationBridgePolicy';
import { upstreamProfileUrlCandidates } from '../../../connectors/activitypub/upstreamProfileUrl';
import { BRIDGED_ACTOR_FIXTURES } from './fixtures/bridgedActors';

/** The upstream handle a captured actor is mirrored under — its acct's local part. */
function upstreamHandleOf(candidate: NetworkIdentityCandidate): string {
  const atIndex = candidate.acct.indexOf('@');
  if (atIndex <= 0) throw new Error(`fixture acct is not a <local>@<host>: ${candidate.acct}`);
  return candidate.acct.slice(0, atIndex);
}

function entryFor(host: string): FederationBridgeEntry {
  const found = federationBridges.findBridge(host);
  if (!found) throw new Error(`no bridge entry for "${host}"`);
  return found;
}

function derivedIdentity(candidate: NetworkIdentityCandidate): string {
  const identity = federationBridges.deriveNetworkIdentity(candidate);
  if (!identity) throw new Error(`${candidate.actorUri} derived no identity`);
  return identity.federatedUsername;
}

describe('pasted profile URL → bridge candidates, against real bridged actors', () => {
  it.each(BRIDGED_ACTOR_FIXTURES.map((f) => [f.acct, f] as const))(
    'reaches %s from the URL a reader would paste',
    (acct, fixture) => {
      const entry = entryFor(fixture.host);
      const pasted = upstreamProfileUrl(entry.network, upstreamHandleOf(fixture));

      expect(upstreamProfileUrlCandidates(pasted)).toContainEqual({
        acct,
        bridgeHost: entry.host,
        expectedFederatedUsername: derivedIdentity(fixture),
      });
    },
  );

  it('offers every enabled bridge for the network, in committed policy order', () => {
    // Two reviewed bridges mirror X, so a pasted x.com link has to reach both —
    // in the order the policy commits them, never one invented here.
    expect(upstreamProfileUrlCandidates('https://x.com/elonmusk').map((c) => c.bridgeHost)).toEqual(
      FEDERATION_BRIDGE_POLICY
        .filter((entry) => entry.network.id === FEDERATION_NETWORKS.x.id && entry.relabel === 'enabled')
        .map((entry) => entry.host),
    );
  });

  it('names one identity per network however many bridges answer', () => {
    const candidates = upstreamProfileUrlCandidates('https://x.com/elonmusk');
    expect(candidates.length).toBeGreaterThan(1);
    expect(new Set(candidates.map((c) => c.expectedFederatedUsername))).toEqual(
      new Set(['elonmusk@x.com']),
    );
  });

  it('reads the aliases, tracking parameters and casing a real paste carries', () => {
    const expected = [{
      acct: 'elonmusk@bird.makeup',
      bridgeHost: 'bird.makeup',
      expectedFederatedUsername: 'elonmusk@x.com',
    }];

    for (const pasted of [
      'https://x.com/ElonMusk',
      'https://twitter.com/elonmusk',
      'https://mobile.twitter.com/elonmusk',
      'https://X.com/elonmusk/',
      'https://x.com/elonmusk?s=20&t=abc',
      'https://x.com/elonmusk#bio',
      '  https://x.com/elonmusk  ',
    ]) {
      expect(upstreamProfileUrlCandidates(pasted).slice(0, 1)).toEqual(expected);
    }
  });

  it('drops the .bsky.social a default handle spells out, and keeps a custom domain whole', () => {
    // Both spellings are the same account to Bluesky, and the two have to agree
    // with the row the atproto connector holds natively or they are two people.
    expect(upstreamProfileUrlCandidates('https://bsky.app/profile/georgemonbiot.bsky.social')).toEqual([{
      acct: 'georgemonbiot.bsky.social@bsky.brid.gy',
      bridgeHost: 'bsky.brid.gy',
      expectedFederatedUsername: 'georgemonbiot@bsky.social',
    }]);
    expect(upstreamProfileUrlCandidates('https://bsky.app/profile/thistleandmoss.com')).toEqual([{
      acct: 'thistleandmoss.com@bsky.brid.gy',
      bridgeHost: 'bsky.brid.gy',
      expectedFederatedUsername: 'thistleandmoss.com@bsky.social',
    }]);
  });
});

describe('pasted profile URL → nothing, for everything we do not reach', () => {
  it.each([
    // A host no reviewed entry names — including a real fediverse instance, whose
    // profile URLs are a different feature and must not be guessed at here.
    ['an unlisted host', 'https://mastodon.social/@Gargron'],
    ['an ordinary web page', 'https://example.com/foo'],
    // `threads.net` is native ActivityPub, deliberately not a bridge entry.
    ['a network that is not bridged', 'https://www.threads.net/@zuck'],
    ['a non-profile path on a listed host', 'https://x.com/i/lists/123'],
    ['a listed host with no path at all', 'https://x.com/'],
    ['a non-http scheme', 'javascript:alert(1)//x.com/elonmusk'],
    ['a handle query rather than a URL', '@alice@mastodon.social'],
    ['a bare atproto handle', 'alice.bsky.social'],
    ['a local username', '@nate'],
    ['nothing at all', ''],
  ])('derives no candidate from %s', (_label, query) => {
    expect(upstreamProfileUrlCandidates(query)).toEqual([]);
  });

  it.each([
    ['an @', 'https://x.com/elonmusk%40x.com'],
    ['a /', 'https://x.com/elon%2Fmusk'],
    ['whitespace', 'https://x.com/elon%20musk'],
  ])('refuses a handle that percent-decodes to contain %s', (_label, query) => {
    // The acct these would build addresses something other than it reads as —
    // `elonmusk@x.com@bird.makeup` is not a request about elonmusk. Same shapes
    // the relabeller refuses to build an identity from.
    expect(upstreamProfileUrlCandidates(query)).toEqual([]);
  });
});

describe('which entries may be a candidate', () => {
  const NETWORK_UNCHANGED = {
    operator: 'test',
    software: 'test',
    derive: () => undefined,
    caseRule: 'lowercase',
    upstreamIdStability: 'recyclable',
    boilerplate: [],
    consent: 'unconsented',
    evidence: 'synthetic entry, this test only',
    assumption: '',
    since: '2026-08-02',
  } as const satisfies Omit<FederationBridgeEntry, 'host' | 'network' | 'relabel'>;

  it('skips an entry whose relabel is deliberately inert', () => {
    // A `pending_dedup` bridge derives no identity by review decision, so an
    // actor ingested through it would be stored under the BRIDGE handle — the
    // visible twin that state exists to prevent, and never the pasted account.
    const entries: FederationBridgeEntry[] = [
      { ...NETWORK_UNCHANGED, host: 'inert.example', network: FEDERATION_NETWORKS.x, relabel: 'pending_dedup' },
      { ...NETWORK_UNCHANGED, host: 'live.example', network: FEDERATION_NETWORKS.x, relabel: 'enabled' },
    ];

    expect(upstreamProfileUrlCandidates('https://x.com/elonmusk', entries).map((c) => c.bridgeHost))
      .toEqual(['live.example']);
  });

  it('never asks a bridge about a network it does not mirror', () => {
    // Being reviewed is not a licence to claim any network: the Instagram bridge
    // must not be asked about an X account, or one operator's list of mirrors
    // becomes an answer for accounts they never touched.
    const entries: FederationBridgeEntry[] = [
      { ...NETWORK_UNCHANGED, host: 'gram.example', network: FEDERATION_NETWORKS.instagram, relabel: 'enabled' },
    ];

    expect(upstreamProfileUrlCandidates('https://x.com/elonmusk', entries)).toEqual([]);
    expect(upstreamProfileUrlCandidates('https://instagram.com/elonmusk', entries)).toEqual([{
      acct: 'elonmusk@gram.example',
      bridgeHost: 'gram.example',
      expectedFederatedUsername: 'elonmusk@instagram.com',
    }]);
  });

  it('derives nothing at all from an empty policy', () => {
    expect(upstreamProfileUrlCandidates('https://x.com/elonmusk', [])).toEqual([]);
  });
});
