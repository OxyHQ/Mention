import { describe, expect, it } from 'vitest';

/**
 * Mention's committed bridge entries, checked against REAL bridged actors.
 *
 * The load-bearing assertion is the round trip: every captured actor must derive
 * to the exact handle its bridge asserts upstream, written out by hand rather
 * than computed from the same rule under test. That is the property a wrong
 * entry breaks, and breaking it is how a whole domain gets misattributed.
 *
 * The mechanism these drive is tested in `@oxyhq/federation`; what is tested here
 * is the JUDGEMENT — that this domain mirrors that network, and that this rule
 * reads the upstream handle correctly out of an actor we actually hold.
 */

import {
  FEDERATION_BRIDGE_POLICY,
  federationBridges,
} from '../../../connectors/activitypub/federationBridgePolicy';
import { BRIDGED_ACTOR_FIXTURES } from './fixtures/bridgedActors';
import type { FederationBridgeEntry, NetworkIdentityCandidate } from '@oxyhq/federation';

/** The identity each captured actor MUST re-label to, written out by hand. */
const EXPECTED_IDENTITY: Readonly<Record<string, string>> = {
  'https://bird.makeup/users/typecache': 'typecache@x.com',
  'https://bird.makeup/users/gorskon': 'gorskon@x.com',
  'https://bird.makeup/users/giswqs': 'giswqs@x.com',
  'https://kilogram.makeup/users/robert.habeck': 'robert.habeck@instagram.com',
  'https://kilogram.makeup/users/umwelthilfe': 'umwelthilfe@instagram.com',
  'https://kilogram.makeup/users/plex': 'plex@instagram.com',
  'https://mastox.eu/ap/users/116193264000459783': 'mehdirhasan@x.com',
  'https://mastox.eu/users/FranceskAlbs': 'franceskalbs@x.com',
  'https://mastox.eu/users/gbsumudflotilla': 'gbsumudflotilla@x.com',
};

/**
 * `bsky.brid.gy` actors are captured and their rule is exercised, but they are
 * NOT in the table above: the entry is `pending_dedup`, so re-labelling them is
 * deliberately inert until the merge lands.
 */
const PENDING_ACTOR_URIS: readonly string[] = [
  'https://bsky.brid.gy/ap/did:plc:m4jmanw3astpwhqp54g6yslu',
  'https://bsky.brid.gy/ap/did:plc:codfx2epdduamfycuyi5fjpb',
  'https://bsky.brid.gy/ap/did:plc:vcmpg73bt2wudku3nqgx33yx',
];

function fixture(suffix: string): NetworkIdentityCandidate {
  const found = BRIDGED_ACTOR_FIXTURES.find((candidate) => candidate.actorUri.endsWith(suffix));
  if (!found) throw new Error(`no captured fixture for actor URI ending "${suffix}"`);
  return found;
}

function entryFor(host: string): FederationBridgeEntry {
  const found = federationBridges.findBridge(host);
  if (!found) throw new Error(`no bridge entry for "${host}"`);
  return found;
}

const ENABLED_FIXTURES = BRIDGED_ACTOR_FIXTURES.filter((f) => f.actorUri in EXPECTED_IDENTITY);

describe('bridge entries — derivation round-trips against real actors', () => {
  it('accounts for every captured fixture, enabled or pending', () => {
    expect(BRIDGED_ACTOR_FIXTURES.length).toBe(12);
    expect(ENABLED_FIXTURES.length + PENDING_ACTOR_URIS.length).toBe(BRIDGED_ACTOR_FIXTURES.length);
    expect(new Set(BRIDGED_ACTOR_FIXTURES.map((f) => f.host)).size).toBe(4);
  });

  it.each(ENABLED_FIXTURES.map((f) => [f.actorUri, f] as const))(
    're-labels %s',
    (actorUri, candidate) => {
      const identity = federationBridges.deriveNetworkIdentity(candidate);
      if (!identity) throw new Error(`${actorUri} derived no identity`);
      expect(identity.federatedUsername).toBe(EXPECTED_IDENTITY[actorUri]);
      // oxy-api binds a federated username to its domain; a result that does not
      // satisfy that is rejected downstream, so assert it here per actor.
      expect(identity.federatedUsername.endsWith(`@${identity.instanceDomain}`)).toBe(true);
    },
  );

  it('strips each bridge\'s own boilerplate and leaves the author\'s own words', () => {
    expect(federationBridges.deriveNetworkIdentity(fixture('/users/giswqs'))?.bio).toBe(
      'Associate Professor @utkgeography | @amazon Scholar | Talk about #opensource #geospatial #dataviz #GeoAI',
    );
    expect(federationBridges.deriveNetworkIdentity(fixture('/users/gbsumudflotilla'))?.bio).toBe(
      'The World’s Biggest Maritime Mission to Break the Illegal Israeli Siege on Gaza. '
      + 'This is our only official account. Registrations open ↓',
    );
  });

  it('derives the mastox handle from preferredUsername, never from the numeric URI', () => {
    // `https://mastox.eu/ap/users/116193264000459783` — reading the URI path here
    // would produce `116193264000459783@x.com`, a plausible-looking handle that
    // belongs to nobody.
    const identity = federationBridges.deriveNetworkIdentity(fixture('116193264000459783'));
    expect(identity?.federatedUsername).toBe('mehdirhasan@x.com');
  });
});

describe('bridge entries — the pending_dedup gate', () => {
  /**
   * Re-labelling a Bridgy actor derives `@handle@bsky.social`, which is exactly
   * what the atproto connector already renders for the same account — 79 of our
   * 815 Bridgy actors are accounts we hold natively. Enabling this without the
   * merge would produce certain, visible twins.
   */
  it.each(PENDING_ACTOR_URIS)('does not re-label %s yet', (actorUri) => {
    const candidate = BRIDGED_ACTOR_FIXTURES.find((f) => f.actorUri === actorUri);
    if (!candidate) throw new Error(`missing fixture ${actorUri}`);
    expect(federationBridges.deriveNetworkIdentity(candidate)).toBeUndefined();
  });

  it('still derives the correct handle underneath, so enabling it is a one-word change', () => {
    // The rule is exercised even while inert: `.bsky.social` is stripped so the
    // result matches what the direct atproto connector stores for the account.
    const candidate = fixture('did:plc:codfx2epdduamfycuyi5fjpb');
    const entry = entryFor('bsky.brid.gy');
    expect(entry.derive(candidate)).toBe('georgemonbiot');
  });

  it('marks exactly the entries whose network has a non-empty collision set', () => {
    const pending = FEDERATION_BRIDGE_POLICY.filter((e) => e.relabel === 'pending_dedup');
    expect(pending.map((e) => e.host)).toEqual(['bsky.brid.gy']);
  });
});

describe('bridge entries — what they refuse', () => {
  it('does not re-label the bridge operator\'s own account', () => {
    // Captured live from https://mastox.eu/users/admin: a `Person`, not a mirror,
    // whose bio describes the SERVICE without carrying the per-account notice.
    // Relabelling this human onto x.com would invent an X account called `admin`.
    expect(federationBridges.deriveNetworkIdentity({
      host: 'mastox.eu',
      acct: 'admin@mastox.eu',
      preferredUsername: 'admin',
      actorUri: 'https://mastox.eu/users/admin',
      actorType: 'Person',
      alsoKnownAs: [],
      fields: [],
      bio:
        "Administrateur de l'instance Mastox, miroir de comptes twitter/X vers Mastodon.\n\n"
        + 'Admin of the Mastox instance, a twitter/X to Mastodon mirror system.',
    })).toBeUndefined();
  });

  it('does not re-label the instance actor', () => {
    // https://mastox.eu/actor — an `Application` named `mastodon.internal`.
    expect(federationBridges.deriveNetworkIdentity({
      host: 'mastox.eu',
      acct: 'mastodon.internal@mastox.eu',
      preferredUsername: 'mastodon.internal',
      actorUri: 'https://mastox.eu/actor',
      actorType: 'Application',
      alsoKnownAs: [],
      fields: [],
      bio: '',
    })).toBeUndefined();
  });

  it('does not re-label an ordinary actor from a host no entry names', () => {
    expect(federationBridges.deriveNetworkIdentity({
      host: 'mastodon.social',
      acct: 'alice@mastodon.social',
      preferredUsername: 'alice',
      actorUri: 'https://mastodon.social/users/alice',
      actorType: 'Person',
      alsoKnownAs: [],
      fields: [{ name: 'Official', value: '<a href="https://twitter.com/alice">x</a>' }],
      bio: '',
    })).toBeUndefined();
  });

  it('does not register threads.net, which is native ActivityPub rather than a bridge', () => {
    // `acct:zuck@threads.net` resolves to a threads.net actor, so `@user@threads.net`
    // is already correct provenance — an entry here would introduce a bug.
    expect(federationBridges.findBridge('threads.net')).toBeUndefined();
    expect(FEDERATION_BRIDGE_POLICY.some((e) => e.host.includes('threads'))).toBe(false);
  });
});

describe('bridge entries — the shape of the committed list', () => {
  it('is written in the canonical host form it is compared in', () => {
    for (const entry of FEDERATION_BRIDGE_POLICY) {
      expect(entry.host).toBe(entry.host.trim().toLowerCase());
      expect(entry.host.startsWith('www.')).toBe(false);
      expect(entry.host).not.toContain('/');
    }
  });

  it('names one host once', () => {
    const hosts = FEDERATION_BRIDGE_POLICY.map((e) => e.host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('records evidence for every entry, and an assumption wherever one is being made', () => {
    for (const entry of FEDERATION_BRIDGE_POLICY) {
      expect(entry.evidence.length).toBeGreaterThan(80);
      expect(entry.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // mastox.eu is the one entry whose handle mapping is inferred rather than read
    // off an assertion the actor publishes; that has to be stated, not implied by
    // an empty field that also means "nobody checked".
    expect(entryFor('mastox.eu').assumption.length).toBeGreaterThan(80);
    // Bridgy carries the atproto DID, so its upstream id is immutable.
    expect(entryFor('bsky.brid.gy').upstreamIdStability).toBe('stable');
    expect(entryFor('bsky.brid.gy').assumption).toBe('');
  });

  it('names the recyclable-handle residual on every network that has one', () => {
    // X and Instagram release abandoned handles, so a derived key is not a
    // permanent identifier and any merge on it inherits that risk.
    for (const host of ['bird.makeup', 'kilogram.makeup', 'mastox.eu']) {
      expect(entryFor(host).upstreamIdStability).toBe('recyclable');
      expect(entryFor(host).assumption.length).toBeGreaterThan(40);
    }
  });

  it('lets each bridge vouch only for the network it mirrors', () => {
    expect(federationBridges.vouchesForNetwork('bird.makeup', 'x.com')).toBe(true);
    expect(federationBridges.vouchesForNetwork('bird.makeup', 'instagram.com')).toBe(false);
    expect(federationBridges.vouchesForNetwork('kilogram.makeup', 'instagram.com')).toBe(true);
    expect(federationBridges.vouchesForNetwork('attacker.example', 'x.com')).toBe(false);
  });
});
