import { describe, expect, it, vi } from 'vitest';
import {
  FEDERATION_BLOCK_POLICY,
  getBlockedDomainPolicy,
  resolveFederationBlocks,
  type FederationBlockPolicyEntry,
} from '../../../connectors/activitypub/federationBlockPolicy';

/**
 * The policy FILE: the merge that turns the committed list plus the environment
 * lever into the one array that is enforced and published, and the shape rules
 * the committed entries have to keep.
 *
 * The end-to-end proof that this array is what the server enforces and what the
 * transparency page renders lives in `../federationTransparency.test.ts`. This
 * file covers the merge itself, where the fixtures can be nastier than anything
 * worth committing: duplicates across both inputs, a domain written the way a
 * human actually mistypes it, blank entries.
 *
 * RFC 2606 reserves `.invalid`, so no fixture below can be mistaken for a real
 * moderation decision.
 */

function entry(overrides: Partial<FederationBlockPolicyEntry> = {}): FederationBlockPolicyEntry {
  return {
    domain: 'example.invalid',
    severity: 'suspend',
    category: 'spam',
    reason: 'Bulk automated posting into unrelated conversations.',
    since: '2026-08-02',
    corroboratingSources: [],
    ...overrides,
  };
}

describe('getBlockedDomainPolicy', () => {
  it('returns reviewed entries only — never the environment lever', () => {
    // The automatic blocked-domain purge keys off this function, and deleting
    // already-ingested content is irreversible. A committed entry carries a
    // diff, an author and a review; an environment value carries none of those,
    // so it must be unreachable from here BY SHAPE — not by a filter the caller
    // has to remember to write.
    const committed = [entry({ domain: 'reviewed.invalid' })];

    // Stubbed so the assertion below can actually FAIL if the accessor ever
    // starts consulting the environment. Without a value present, a version of
    // this function that read `FEDERATION_BLOCKED_DOMAINS` would produce
    // identical output and the check would be decorative. Scoped to this test —
    // `blockedDomainEnforcement.test.ts` sets the same variable, and vitest
    // workers share `process.env`.
    vi.stubEnv('FEDERATION_BLOCKED_DOMAINS', 'from-the-console.invalid');

    const merged = resolveFederationBlocks(committed, ['from-the-console.invalid']);
    const policyOnly = getBlockedDomainPolicy(committed);

    vi.unstubAllEnvs();

    // The merged view — what the transparency page publishes — does carry it.
    expect(merged.map((block) => block.domain)).toContain('from-the-console.invalid');
    // The policy view does not, and takes no input through which it could.
    expect(policyOnly.map((item) => item.domain)).toEqual(['reviewed.invalid']);
  });

  it('canonicalises every domain, so no consumer has to know the comparison form', () => {
    const parsed = getBlockedDomainPolicy([
      entry({ domain: '  WWW.Shouty.INVALID  ' }),
      entry({ domain: 'Plain.INVALID' }),
    ]);

    expect(parsed.map((item) => item.domain)).toEqual(['plain.invalid', 'shouty.invalid']);
  });

  it('keeps the reason, date and corroboration attached to each domain', () => {
    // A consumer recording WHY it acted reads these off the same entry, rather
    // than inventing a parallel audit vocabulary.
    const [parsed] = getBlockedDomainPolicy([
      entry({ domain: 'documented.invalid', corroboratingSources: ['mastodon.social'] }),
    ]);

    expect(parsed).toEqual({
      domain: 'documented.invalid',
      severity: 'suspend',
      category: 'spam',
      reason: 'Bulk automated posting into unrelated conversations.',
      since: '2026-08-02',
      corroboratingSources: ['mastodon.social'],
    });
  });

  it('collapses a domain committed twice, so a consumer never acts on it twice', () => {
    const parsed = getBlockedDomainPolicy([
      entry({ domain: 'twice.invalid', reason: 'First write-up.' }),
      entry({ domain: 'WWW.Twice.invalid', reason: 'Corrected write-up.' }),
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].reason).toBe('Corrected write-up.');
  });

  it('drops a blank domain rather than handing out an entry that matches nothing', () => {
    expect(getBlockedDomainPolicy([entry({ domain: '   ' })])).toEqual([]);
  });

  it('defaults to the committed policy', () => {
    expect(getBlockedDomainPolicy()).toEqual(getBlockedDomainPolicy(FEDERATION_BLOCK_POLICY));
  });
});

describe('resolveFederationBlocks', () => {
  it('publishes a committed entry in full and an environment entry as undocumented', () => {
    const resolved = resolveFederationBlocks(
      [entry({ domain: 'documented.invalid', corroboratingSources: ['mastodon.social'] })],
      ['urgent.invalid'],
    );

    expect(resolved).toEqual([
      {
        source: 'operational',
        domain: 'urgent.invalid',
        severity: 'suspend',
      },
      {
        source: 'policy',
        domain: 'documented.invalid',
        severity: 'suspend',
        category: 'spam',
        reason: 'Bulk automated posting into unrelated conversations.',
        since: '2026-08-02',
        corroboratingSources: ['mastodon.social'],
      },
    ].sort((a, b) => a.domain.localeCompare(b.domain)));
  });

  it('canonicalises case, surrounding space and a www. prefix', () => {
    const resolved = resolveFederationBlocks(
      [entry({ domain: '  WWW.Shouty.INVALID  ' })],
      ['  WWW.Loud.INVALID '],
    );

    expect(resolved.map((block) => block.domain)).toEqual(['loud.invalid', 'shouty.invalid']);
  });

  it('keeps the reviewed entry when the same domain is in both inputs', () => {
    const resolved = resolveFederationBlocks([entry({ domain: 'both.invalid' })], ['both.invalid']);

    // The same domain in both inputs is ONE block, and the reviewed entry is the
    // one that can explain itself — publishing the bare operational row instead
    // would throw away a reason we already have.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ source: 'policy', domain: 'both.invalid' });
  });

  it('sorts by domain, so the published order is stable and a diff is readable', () => {
    const resolved = resolveFederationBlocks(
      [entry({ domain: 'zeta.invalid' }), entry({ domain: 'alpha.invalid' })],
      ['middle.invalid'],
    );

    expect(resolved.map((block) => block.domain)).toEqual([
      'alpha.invalid',
      'middle.invalid',
      'zeta.invalid',
    ]);
  });

  it('drops blank inputs rather than publishing an empty domain that blocks nothing', () => {
    // `FEDERATION_BLOCKED_DOMAINS=a.invalid,,  ` is an ordinary typo. An empty
    // string in the enforced set matches no host, but on the page it would read
    // as a block that does not exist.
    const resolved = resolveFederationBlocks([entry({ domain: '   ' })], ['a.invalid', '', '   ']);

    expect(resolved.map((block) => block.domain)).toEqual(['a.invalid']);
  });

  it('returns nothing when neither input has anything', () => {
    expect(resolveFederationBlocks([], [])).toEqual([]);
  });
});

describe('the committed policy file', () => {
  it('ships empty — Mention publishes no block today', () => {
    // This asserts the CURRENT shipped state, which is exactly what the
    // transparency page tells the public. The commit that adds the first entry
    // should delete this assertion; the per-entry invariants below then stop
    // being a gate for the future and start describing real decisions.
    expect(FEDERATION_BLOCK_POLICY).toEqual([]);
  });

  it('states every entry in the canonical, comparable form', () => {
    for (const committed of FEDERATION_BLOCK_POLICY) {
      // `resolveFederationBlocks` canonicalises anyway, so a slip cannot fail to
      // block. This is about the file reading exactly as it behaves.
      expect(committed.domain).toBe(committed.domain.trim().toLowerCase());
      expect(committed.domain.startsWith('www.')).toBe(false);
      expect(committed.domain).not.toMatch(/[/:\s]/);
      expect(committed.domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
  });

  it('gives every entry a published reason and a date it took effect', () => {
    for (const committed of FEDERATION_BLOCK_POLICY) {
      // The page's whole promise is that it says WHY. An entry without a reason
      // is a name on a list.
      expect(committed.reason.trim().length).toBeGreaterThan(0);
      expect(committed.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(committed.since))).toBe(false);

      // Corroborating sources are instances, named the same way a domain is.
      for (const source of committed.corroboratingSources) {
        expect(source).toBe(source.trim().toLowerCase());
        expect(source).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      }
    }
  });
});
