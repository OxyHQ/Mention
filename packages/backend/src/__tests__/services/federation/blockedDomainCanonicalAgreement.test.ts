import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalFederationHost,
  createDomainPolicy,
  isSameFederationHost,
} from '@oxyhq/federation';
import {
  getBlockedDomainPolicy,
  resolveFederationBlocks,
  type FederationBlockPolicyEntry,
} from '../../../connectors/activitypub/federationBlockPolicy';
import * as policyModule from '../../../connectors/activitypub/federationBlockPolicy';
import { buildBlockedContentDomains } from '../../../scripts/purgeBlockedDomainContent';

/**
 * ONE BLOCKLIST, THREE READERS, ONE VERDICT.
 *
 * A domain written into the committed policy is read by three pieces of code
 * that each do something different with it: the federation engine REFUSES the
 * host at the wire, the transparency page TELLS the public it is refused, and
 * the automatic purge DELETES what we already hold from it. They only ever agree
 * if they decide "is this the same host?" the same way — and until
 * `@oxyhq/federation@0.6.0` they could not be made to, because the engine kept
 * its canonicaliser private and Mention held a hand-copy.
 *
 * That copy is now deleted and all three call `canonicalFederationHost`, the
 * engine's own function. This file is where that stops being a claim: every case
 * below drives the REAL `createDomainPolicy` rather than a mock, because a mock
 * would agree with whatever Mention does, which is precisely the failure being
 * guarded against.
 *
 * The direction that matters most is the purge's. Refusing a host we did not
 * mean to refuse is a bug someone can report; deleting an instance's content for
 * a block that was never in force is not undoable. So "broader than the engine"
 * is asserted as its own property, separately from plain agreement.
 */

const FEDERATION_DOMAIN = 'mention.earth';
const IDENTITY_APEX = 'oxy.so';
const OWN = [FEDERATION_DOMAIN, IDENTITY_APEX];

function entry(domain: string): FederationBlockPolicyEntry {
  return {
    domain,
    severity: 'suspend',
    category: 'spam',
    reason: 'Bulk automated posting into unrelated conversations.',
    since: '2026-08-02',
    corroboratingSources: [],
  };
}

/**
 * The three readers, each fed from the SAME committed entry and each answering
 * the same question about the same host.
 *
 * The wiring is the real one in miniature: `constants.ts` derives the enforced
 * set from `resolveFederationBlocks`' output, which is also the array the
 * `/federation/blocked-domains` endpoint serves, and the purge reads
 * `getBlockedDomainPolicy` directly. Nothing here is stubbed.
 */
function verdicts(committed: string, host: string) {
  const policy = getBlockedDomainPolicy([entry(committed)]);
  const published = resolveFederationBlocks(policy, []);

  return {
    /** What the wire does: the engine's own predicate, built as `constants.ts` builds it. */
    engine: createDomainPolicy({
      domain: FEDERATION_DOMAIN,
      actorDomain: FEDERATION_DOMAIN,
      identityApex: IDENTITY_APEX,
      blockedDomains: published.map((block) => block.domain),
    }).isBlockedDomain(host),

    /**
     * What a reader of the transparency page would conclude. The page prints
     * canonical host strings, so the question it answers for a given host is
     * whether any printed name IS that host — `isSameFederationHost`, the
     * engine's own comparison, rather than a string equality this test invented.
     */
    page: published.some((block) => isSameFederationHost(block.domain, host)),

    /** What the purge would delete. */
    purge: buildBlockedContentDomains(
      policy.map((item) => item.domain),
      OWN,
    ).has(canonicalFederationHost(host)),
  };
}

describe('the engine, the transparency page and the purge reach one verdict', () => {
  it.each([
    ['the plain spelling', 'spam.example', 'spam.example', true],
    ['a host arriving in caps', 'spam.example', 'SPAM.EXAMPLE', true],
    ['a host arriving with www.', 'spam.example', 'www.spam.example', true],
    ['an entry written with www.', 'www.spam.example', 'spam.example', true],
    ['an entry written in caps', 'WWW.Spam.EXAMPLE', 'spam.example', true],
    // Exact matching, stated as a fact rather than assumed: naming a host does
    // not name the hosts under it. Widening this is a POLICY change, and the
    // transparency page would have to stop saying a block covers the exact host
    // named. See `federationBlockPolicy.ts`.
    ['a subdomain of a blocked host', 'spam.example', 'sub.spam.example', false],
    ['a parent of a blocked subdomain', 'sub.spam.example', 'spam.example', false],
    // A trailing dot is the fully-qualified spelling in DNS but a different
    // string here, on the page and at the wire alike.
    ['a trailing-dot entry against the bare host', 'spam.example.', 'spam.example', false],
    ['a trailing-dot host against a bare entry', 'spam.example', 'spam.example.', false],
    ['an unrelated instance', 'spam.example', 'mastodon.social', false],
    ['a host the blocked name is a prefix of', 'spam.example', 'spam.example.evil.test', false],
  ])('agrees on %s', (_case, committed, host, blocked) => {
    const { engine, page, purge } = verdicts(committed, host);

    // Pinned to an expected verdict as well as to each other: three readers that
    // agreed on the WRONG answer would otherwise pass.
    expect({ engine, page, purge }).toEqual({ engine: blocked, page: blocked, purge: blocked });
  });

  it('never lets the purge reach further than the engine refuses', () => {
    // The asymmetric property, asserted on its own because the two directions do
    // not cost the same. Under-blocking is a bug; over-deleting is unrecoverable.
    const spellings = ['spam.example', 'WWW.Spam.EXAMPLE', 'spam.example.', 'sub.spam.example'];
    const hosts = [
      'spam.example',
      'SPAM.EXAMPLE',
      'www.spam.example',
      'sub.spam.example',
      'spam.example.',
      'spam.example.evil.test',
      'notspam.example',
      'mastodon.social',
    ];

    let blockedPairs = 0;
    for (const committed of spellings) {
      for (const host of hosts) {
        const { engine, purge } = verdicts(committed, host);
        expect(purge && !engine, `purge would delete ${host} that the engine does not block`)
          .toBe(false);
        if (engine) blockedPairs += 1;
      }
    }

    // Vacuity floor: a harness that stopped resolving any host would satisfy the
    // assertion above for every pair while proving nothing.
    expect(blockedPairs).toBeGreaterThan(0);
  });

  it('refuses our own domains at the wire without ever publishing or purging them', () => {
    for (const own of OWN) {
      const { engine, page, purge } = verdicts('spam.example', own);

      // Identity, not moderation: both hosts publish our own users. The engine
      // must refuse them, and the other two must never act on that refusal.
      expect(engine).toBe(true);
      expect(page).toBe(false);
      expect(purge).toBe(false);
    }
  });
});

describe('the canonicaliser is the engine’s, not a copy of it', () => {
  it('is imported from @oxyhq/federation, which only 0.6.0 onwards exports', () => {
    // The structural half of this change. On `^0.5.0` these were not exported at
    // all, so this file could not run — which is what makes the version bump and
    // the deletion one commit rather than two.
    expect(typeof canonicalFederationHost).toBe('function');
    expect(typeof isSameFederationHost).toBe('function');
  });

  it('leaves no canonicaliser behind in the policy module for anything to drift from', () => {
    // `canonicalBlockedDomain` was the hand-copy. Re-adding one under that name
    // would restore exactly the two-implementations problem this deleted.
    expect(Object.keys(policyModule)).not.toContain('canonicalBlockedDomain');
    expect(Object.keys(policyModule).length).toBeGreaterThan(0);
  });

  it('has no second implementation of the www. rule anywhere in the backend', () => {
    // The copy was found by its shape, not its name, so the guard looks for the
    // shape: any other place stripping a leading `www.` by hand is a second
    // opinion about which hosts are which, and is what this change removed.
    return expectNoHandRolledWwwStripping();
  });
});

/**
 * Scan the backend's own source for a hand-rolled `www.` strip.
 *
 * Deliberately a source scan and not a lint rule: the drift this guards against
 * is someone writing four correct-looking lines in an unrelated file, which no
 * type or import check can see. The vacuity floor is the part that makes it
 * mean anything — a walk that silently found nothing would otherwise report a
 * clean run forever.
 */
async function expectNoHandRolledWwwStripping(): Promise<void> {
  const sourceRoot = resolve(__dirname, '../../..');
  const offenders: string[] = [];
  let scanned = 0;

  async function walk(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        if (item.name === 'node_modules' || item.name === '__tests__') continue;
        await walk(path);
        continue;
      }
      if (!item.name.endsWith('.ts')) continue;
      scanned += 1;

      const contents = await readFile(path, 'utf8');
      for (const [index, line] of contents.split('\n').entries()) {
        // Prose in a comment explaining the rule is not an implementation of it.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/startsWith\(\s*['"`]www\./.test(code) || /replace\(\s*\/\^www\\?\./.test(code)) {
          offenders.push(`${relative(sourceRoot, path)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
  }

  await walk(sourceRoot);

  expect(offenders, 'use canonicalFederationHost from @oxyhq/federation instead').toEqual([]);
  // Well below the current count (472 non-test `.ts` files) so ordinary
  // deletions never trip it, but high enough that a walk which stopped
  // descending could not report a clean run.
  expect(scanned).toBeGreaterThan(300);
}
