import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { FederationBlocksResponse } from '@mention/shared-types';

/**
 * THE PUBLISHED POLICY AND THE ENFORCED POLICY ARE THE SAME POLICY.
 *
 * A transparency page fails in exactly one way that matters: it describes a
 * moderation policy the server is not applying. That does not happen through
 * malice, it happens through a second source of truth — a list rendered from one
 * place and enforced from another, drifting one entry at a time until the page
 * is a lie nobody noticed telling.
 *
 * So the whole surface is built so the two CANNOT disagree: the enforced set is
 * derived from the very array the endpoint serves. This file is where that claim
 * is actually made to earn its keep, end to end and through the real wiring:
 *
 *     committed policy file ─┐
 *                            ├─► FEDERATION_BLOCKS ─┬─► isBlockedDomain (enforcement)
 *     FEDERATION_BLOCKED_DOMAINS ─┘                 └─► GET /federation/blocked-domains (the page)
 *
 * The DATA is a fixture — the committed policy ships empty, and a test that
 * looped over an empty list would pass while proving nothing. The WIRING is
 * real: `constants.ts`, `createDomainPolicy` inside `@oxyhq/federation`, and the
 * live Express router, none of them stubbed. Every blocked assertion is paired
 * with an allowed-domain control, so a harness that quietly stopped working
 * could not read as a pass.
 *
 * Both inputs are exercised, because they fail differently: the committed file
 * is the documented lane, and `FEDERATION_BLOCKED_DOMAINS` is the emergency lane
 * that must stay enforced AND stay visible rather than becoming a way to block
 * something off the record.
 */

const mocks = vi.hoisted(() => {
  // Set BEFORE any import: `config` parses `process.env` once at module load and
  // `constants.ts` freezes the domain policy from it at import time.
  process.env.FEDERATION_BLOCKED_DOMAINS = 'urgent.invalid';

  return {
    /**
     * Stands in for the committed policy file. `.invalid` is reserved by RFC 2606
     * and can never be a real instance, so no fixture here can be mistaken for a
     * moderation decision Mention has actually taken.
     *
     * `WWW.Mixed.Case.INVALID` is deliberately written in the form a human slip
     * produces. It proves the module's canonicalisation agrees with the
     * federation engine's: publish it in one form, block it in the other.
     */
    policyFixture: [
      {
        domain: 'spam-farm.invalid',
        severity: 'suspend' as const,
        category: 'spam' as const,
        reason: 'Bulk automated posting into unrelated conversations.',
        since: '2026-08-02',
        corroboratingSources: ['mastodon.social', 'mstdn.social'],
      },
      {
        domain: 'WWW.Mixed.Case.INVALID',
        severity: 'suspend' as const,
        category: 'unmoderated' as const,
        reason: 'Reports to its administrators go unanswered.',
        since: '2026-08-02',
        corroboratingSources: [],
      },
    ],
    getUserById: vi.fn(),
  };
});

// The ACCESSOR is the seam, not the constant behind it: `constants.ts` reads the
// policy through `getBlockedDomainPolicy()`, and so does the automatic
// blocked-domain purge, so mocking here swaps the committed data for every
// consumer at once. `resolveFederationBlocks` is left real — it is under test.
vi.mock('../../connectors/activitypub/federationBlockPolicy', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../connectors/activitypub/federationBlockPolicy')
  >()),
  getBlockedDomainPolicy: () => mocks.policyFixture,
}));

// The route module transitively imports the connector registry and the model
// graph. Stub the heavy/circular deps so it loads standalone — but NOT
// `activitypub/constants` or the policy resolver, which are the code under test.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: mocks.getUserById }),
}));
vi.mock('@oxyhq/core/server', () => ({ getRequiredOxyUserId: () => 'local-user-1' }));
vi.mock('../../connectors/atproto/constants', () => ({
  ATPROTO_ENABLED: false,
  isDid: () => false,
  isAtUri: () => false,
  isAtprotoHandle: () => false,
}));
vi.mock('../../connectors/index', () => ({
  connectorRegistry: { list: () => [], connectorFor: vi.fn(), resolve: vi.fn(async () => null) },
}));
vi.mock('../../connectors/resolve', () => ({ classifyQuery: vi.fn(() => 'activitypub') }));
vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {},
  isPermanentlyUnavailableOutboxReason: vi.fn(() => false),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  getServiceOxyClient: () => ({ getUserById: mocks.getUserById }),
}));
vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(async () => true),
  invalidateFediverseSharing: vi.fn(async () => undefined),
}));
vi.mock('../../connectors/activitypub/webfingerCache', () => ({
  invalidateWebfingerCache: vi.fn(async () => undefined),
}));
vi.mock('../../queue/producers', () => ({ enqueueSharingCleanup: vi.fn(async () => true) }));
vi.mock('../../connectors/activitypub/sharingCleanup.service', () => ({
  runSharingCleanup: vi.fn(async () => ({ deletesSent: 0, followersRemoved: 0 })),
}));

import {
  FEDERATION_BLOCKS,
  FEDERATION_DOMAIN,
  isBlockedDomain,
} from '../../connectors/activitypub/constants';
import { OXY_IDENTITY_APEX } from '../../connectors/activitypub/ownDomain';
import connectorsRoutes from '../../connectors/connectors.routes';

const app = express();
app.use(express.json());
app.use('/federation', connectorsRoutes);

/** A domain in neither input — the control that proves nothing blocks by accident. */
const UNBLOCKED_DOMAIN = 'ordinary-instance.invalid';

async function fetchPublishedBlocks(): Promise<FederationBlocksResponse['blocks']> {
  const response = await request(app).get('/federation/blocked-domains').expect(200);
  const body = response.body as FederationBlocksResponse;
  return body.blocks;
}

describe('the published blocklist and the enforced one are one list', () => {
  it('enforces every domain it publishes, and publishes every domain it enforces', async () => {
    const published = await fetchPublishedBlocks();

    // Vacuity floor. Two committed fixtures + one environment entry: a traversal
    // that silently returned nothing would otherwise satisfy every `every()`
    // below.
    expect(published).toHaveLength(3);

    for (const block of published) {
      expect(isBlockedDomain(block.domain)).toBe(true);
    }
    expect(published.map((block) => block.domain)).toEqual([
      'mixed.case.invalid',
      'spam-farm.invalid',
      'urgent.invalid',
    ]);

    // Control: the same assertions run against a domain in neither input.
    expect(isBlockedDomain(UNBLOCKED_DOMAIN)).toBe(false);
    expect(published.some((block) => block.domain === UNBLOCKED_DOMAIN)).toBe(false);
  });

  it('serves exactly the array the enforced set is derived from', async () => {
    expect(await fetchPublishedBlocks()).toEqual([...FEDERATION_BLOCKS]);
  });

  it('publishes a committed entry with the reason and corroboration it was decided on', async () => {
    const published = await fetchPublishedBlocks();

    expect(published).toContainEqual({
      source: 'policy',
      domain: 'spam-farm.invalid',
      severity: 'suspend',
      category: 'spam',
      reason: 'Bulk automated posting into unrelated conversations.',
      since: '2026-08-02',
      corroboratingSources: ['mastodon.social', 'mstdn.social'],
    });
  });

  it('publishes an urgent environment block as undocumented rather than hiding it', async () => {
    const published = await fetchPublishedBlocks();

    // The emergency lever exists so a block need not wait for a deploy. It must
    // not become a way to block something without saying so.
    expect(published).toContainEqual({
      source: 'operational',
      domain: 'urgent.invalid',
      severity: 'suspend',
    });
    expect(isBlockedDomain('urgent.invalid')).toBe(true);
  });

  it('canonicalises a domain the same way the federation engine compares it', async () => {
    const published = await fetchPublishedBlocks();

    // Committed as `WWW.Mixed.Case.INVALID`; published — and enforced — bare and
    // lowercased. If this module and the engine disagreed on the comparison
    // form, a published domain would go unenforced.
    expect(published).toContainEqual({
      source: 'policy',
      domain: 'mixed.case.invalid',
      severity: 'suspend',
      category: 'unmoderated',
      reason: 'Reports to its administrators go unanswered.',
      since: '2026-08-02',
      corroboratingSources: [],
    });
    expect(isBlockedDomain('WWW.Mixed.Case.INVALID')).toBe(true);
    expect(isBlockedDomain('mixed.case.invalid')).toBe(true);
  });
});

describe('what the page must never claim', () => {
  it('never lists our own domains, which are refused for identity reasons and not moderation ones', async () => {
    const published = await fetchPublishedBlocks();

    // Both hosts publish OUR OWN users, so the federation policy refuses them to
    // avoid duplicating local accounts. Listing them among "instances we refuse"
    // would be a plain falsehood about Mention itself.
    expect(isBlockedDomain(FEDERATION_DOMAIN)).toBe(true);
    expect(isBlockedDomain(OXY_IDENTITY_APEX)).toBe(true);

    const domains = published.map((block) => block.domain);
    expect(domains).not.toContain(FEDERATION_DOMAIN);
    expect(domains).not.toContain(OXY_IDENTITY_APEX);
  });
});
