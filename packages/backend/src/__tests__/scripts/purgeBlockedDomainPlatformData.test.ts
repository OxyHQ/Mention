import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Offline tests for the driver that asks Oxy to purge what the PLATFORM holds
 * for each blocked instance.
 *
 * The Oxy service client and the persisted resume cursor are the only two
 * things mocked; the real paging loop, the real stall guard, the real
 * mode/canonical agreement checks and the real report all run. The endpoint is
 * scripted per test as a queue of responses so a pass sequence can be stated
 * exactly, and every request body is recorded — because most of what matters
 * here is WHICH requests were issued, not what came back.
 *
 * The properties that would be silent in production if they broke, and are
 * therefore asserted here rather than assumed:
 *   - a dry run issues no destructive request and leaves no state behind;
 *   - the plan and the execute issue byte-identical requests apart from the flag;
 *   - a cursor that does not advance terminates instead of looping forever;
 *   - only domains in the committed policy are ever sent;
 *   - the report leads with `localFollowersAffected`.
 */

const OBJECT_IDS = [
  '6a2f9d8989b795cfdfac3501',
  '6a2f9d8989b795cfdfac3502',
  '6a2f9d8989b795cfdfac3503',
] as const;

const h = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  readAdminScriptCursor: vi.fn(),
  recordAdminScriptCursor: vi.fn(),
  clearAdminScriptCursor: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ makeServiceRequest: h.makeServiceRequest }),
  createScopedOxyClient: vi.fn(),
  uploadServiceUserMedia: vi.fn(),
  ensureProfileMediaPublic: vi.fn(),
  getMentionOxyClientId: vi.fn(),
}));

vi.mock('../../scripts/lib/adminScriptCursor', () => ({
  readAdminScriptCursor: h.readAdminScriptCursor,
  recordAdminScriptCursor: h.recordAdminScriptCursor,
  clearAdminScriptCursor: h.clearAdminScriptCursor,
}));

import {
  assertPlatformPurgeRunComplete,
  buildPurgeRequest,
  DryRunViolationError,
  emptyIssues,
  MalformedPurgeResponseError,
  parseDomainPurgePass,
  purgeBlockedDomainPlatformData,
  purgeDomainOnPlatform,
  renderDomainTable,
  resolvePurgeTargets,
  totalsOf,
  type DomainPurgeRequest,
  type PlatformPurgeOptions,
  type PlatformPurgeReport,
} from '../../scripts/purgeBlockedDomainPlatformData';
import { getBlockedDomainPolicy } from '../../connectors/activitypub/federationBlockPolicy';
import { EmptyBlocklistError } from '../../scripts/purgeBlockedDomainContent';

const DOMAIN = 'spam.example';

function options(overrides: Partial<PlatformPurgeOptions> = {}): PlatformPurgeOptions {
  return {
    dryRun: true,
    batchLimit: 2,
    maxPassesPerDomain: 10,
    resetCursor: false,
    ...overrides,
  };
}

/** A well-formed pass response, with only the fields a test cares about set. */
function pass(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    requestedDomain: DOMAIN,
    canonicalDomain: DOMAIN,
    dryRun: true,
    actorsMatched: 0,
    actorsProcessed: 0,
    actorsDeleted: 0,
    actorsRetained: [],
    filesDeleted: 0,
    bytesDeleted: 0,
    avatarsDeleted: 0,
    followEdgesRemoved: 0,
    localFollowersAffected: 0,
    candidatesRejected: 0,
    remaining: 0,
    nextCursor: null,
    done: true,
    ...overrides,
  };
}

/** Script the endpoint: one queued response per call, in order. */
function respondWith(...responses: unknown[]): void {
  let index = 0;
  h.makeServiceRequest.mockImplementation(async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response instanceof Error) throw response;
    return response;
  });
}

/** Every request body the run issued, in order. */
function issuedRequests(): DomainPurgeRequest[] {
  return h.makeServiceRequest.mock.calls.map((call) => call[2] as DomainPurgeRequest);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readAdminScriptCursor.mockResolvedValue(null);
  h.recordAdminScriptCursor.mockResolvedValue(true);
  h.clearAdminScriptCursor.mockResolvedValue(undefined);
  respondWith(pass());
});

describe('the request', () => {
  it('sends the domain, the batch size and the mode — and never a caller app id', () => {
    const request = buildPurgeRequest(DOMAIN, options({ dryRun: false, batchLimit: 25 }));

    expect(request).toEqual({ domain: DOMAIN, dryRun: false, limit: 25 });
    // Oxy resolves whose data may be deleted from the service credential. A body
    // field claiming an application id is exactly what that design forbids.
    expect(Object.keys(request)).not.toContain('callerAppId');
    expect(Object.keys(request)).not.toContain('appId');
  });

  it('carries the cursor forward as afterId', () => {
    expect(buildPurgeRequest(DOMAIN, options(), OBJECT_IDS[0]))
      .toEqual({ domain: DOMAIN, dryRun: true, limit: 2, afterId: OBJECT_IDS[0] });
  });

  it('omits afterId entirely on the first pass rather than sending a null', () => {
    expect('afterId' in buildPurgeRequest(DOMAIN, options())).toBe(false);
  });
});

describe('the plan and the execute', () => {
  it('issue identical requests apart from the flag', async () => {
    const paged = [
      pass({ nextCursor: OBJECT_IDS[0], done: false, actorsProcessed: 2 }),
      pass({ nextCursor: OBJECT_IDS[1], done: false, actorsProcessed: 2 }),
      pass({ nextCursor: OBJECT_IDS[2], done: true, actorsProcessed: 1 }),
    ];

    respondWith(...paged);
    await purgeDomainOnPlatform(DOMAIN, options({ dryRun: true }), emptyIssues());
    const planned = issuedRequests();

    h.makeServiceRequest.mockClear();
    respondWith(...paged.map((page) => ({ ...page, dryRun: false })));
    await purgeDomainOnPlatform(DOMAIN, options({ dryRun: false }), emptyIssues());
    const executed = issuedRequests();

    expect(planned).toHaveLength(3);
    expect(executed).toHaveLength(3);
    // The numbers an operator approves are only the numbers that will run if the
    // two sequences differ in nothing but the flag.
    expect(executed.map((request) => ({ ...request, dryRun: true }))).toEqual(planned);
    expect(planned.every((request) => request.dryRun === true)).toBe(true);
    expect(executed.every((request) => request.dryRun === false)).toBe(true);
  });
});

describe('a dry run', () => {
  it('issues no destructive request', async () => {
    respondWith(
      pass({ nextCursor: OBJECT_IDS[0], done: false }),
      pass({ nextCursor: OBJECT_IDS[1], done: true }),
    );

    await purgeDomainOnPlatform(DOMAIN, options({ dryRun: true }), emptyIssues());

    expect(issuedRequests()).toHaveLength(2);
    expect(issuedRequests().every((request) => request.dryRun === true)).toBe(true);
  });

  it('writes no resume cursor — a plan leaves nothing behind', async () => {
    respondWith(
      pass({ nextCursor: OBJECT_IDS[0], done: false }),
      pass({ nextCursor: OBJECT_IDS[1], done: true }),
    );

    await purgeDomainOnPlatform(DOMAIN, options({ dryRun: true }), emptyIssues());

    expect(h.recordAdminScriptCursor).not.toHaveBeenCalled();
  });

  it('ignores a recorded cursor on RESET_CURSOR instead of deleting the row', async () => {
    h.readAdminScriptCursor.mockResolvedValue({
      cursor: OBJECT_IDS[0],
      scanned: 4,
      completedAt: null,
    });

    await purgeDomainOnPlatform(DOMAIN, options({ dryRun: true, resetCursor: true }), emptyIssues());

    expect(h.clearAdminScriptCursor).not.toHaveBeenCalled();
    expect(issuedRequests()[0]).not.toHaveProperty('afterId');
  });

  it('still starts where the execute would, so the plan describes that run', async () => {
    h.readAdminScriptCursor.mockResolvedValue({
      cursor: OBJECT_IDS[1],
      scanned: 4,
      completedAt: null,
    });

    await purgeDomainOnPlatform(DOMAIN, options({ dryRun: true }), emptyIssues());

    expect(issuedRequests()[0]?.afterId).toBe(OBJECT_IDS[1]);
  });
});

describe('paging', () => {
  it('echoes nextCursor back as afterId until the endpoint reports done', async () => {
    respondWith(
      pass({ nextCursor: OBJECT_IDS[0], done: false, actorsProcessed: 2 }),
      pass({ nextCursor: OBJECT_IDS[1], done: false, actorsProcessed: 2 }),
      pass({ nextCursor: OBJECT_IDS[2], done: true, actorsProcessed: 1 }),
    );

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), emptyIssues());

    expect(issuedRequests().map((request) => request.afterId))
      .toEqual([undefined, OBJECT_IDS[0], OBJECT_IDS[1]]);
    expect(outcome.done).toBe(true);
    expect(outcome.passes).toBe(3);
    expect(outcome.actorsProcessed).toBe(5);
  });

  it('keeps going while `remaining` stays high — done is the only loop condition', async () => {
    respondWith(
      pass({ nextCursor: OBJECT_IDS[0], done: false, remaining: 900 }),
      pass({ nextCursor: OBJECT_IDS[1], done: true, remaining: 900 }),
    );

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), emptyIssues());

    // Retained rows keep matching forever, so a caller that stopped on
    // `remaining === 0` would never finish and one that looped on it would never
    // stop. It is reported, never obeyed.
    expect(outcome.done).toBe(true);
    expect(outcome.remaining).toBe(900);
  });

  it('resumes from the recorded cursor and records progress after every pass', async () => {
    h.readAdminScriptCursor.mockResolvedValue({
      cursor: OBJECT_IDS[0],
      scanned: 10,
      completedAt: null,
    });
    respondWith(
      pass({ dryRun: false, nextCursor: OBJECT_IDS[1], done: false, actorsProcessed: 2 }),
      pass({ dryRun: false, nextCursor: OBJECT_IDS[2], done: true, actorsProcessed: 1 }),
    );

    await purgeDomainOnPlatform(DOMAIN, options({ dryRun: false }), emptyIssues());

    expect(issuedRequests()[0]?.afterId).toBe(OBJECT_IDS[0]);
    expect(h.recordAdminScriptCursor.mock.calls.map((call) => call[2])).toEqual([
      { cursor: OBJECT_IDS[1], scanned: 12, completed: false },
      { cursor: OBJECT_IDS[2], scanned: 13, completed: true },
    ]);
  });

  it('counts a cursor that could not be persisted, so the run cannot pass silently', async () => {
    h.recordAdminScriptCursor.mockResolvedValue(false);
    respondWith(pass({ dryRun: false, nextCursor: OBJECT_IDS[0], done: true }));
    const issues = emptyIssues();

    await purgeDomainOnPlatform(DOMAIN, options({ dryRun: false }), issues);

    expect(issues.cursorWriteFailed).toBe(1);
    expect(() => assertPlatformPurgeRunComplete(reportWith(issues, 1)))
      .toThrow(/cursorWriteFailed=1/);
  });
});

describe('a cursor that does not advance', () => {
  it('terminates instead of looping when the endpoint repeats it', async () => {
    respondWith(
      pass({ nextCursor: OBJECT_IDS[0], done: false }),
      pass({ nextCursor: OBJECT_IDS[0], done: false }),
      pass({ nextCursor: OBJECT_IDS[0], done: false }),
    );
    const issues = emptyIssues();

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), issues);

    // The second pass asked from OBJECT_IDS[0] and was told to ask from
    // OBJECT_IDS[0] again. Believing that is an infinite loop against production.
    expect(issuedRequests()).toHaveLength(2);
    expect(issues.stalledCursor).toBe(1);
    expect(outcome.failed).toBe(true);
    expect(outcome.done).toBe(false);
  });

  it('terminates when an unfinished pass returns no cursor at all', async () => {
    respondWith(pass({ nextCursor: null, done: false }));
    const issues = emptyIssues();

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), issues);

    expect(issuedRequests()).toHaveLength(1);
    expect(issues.stalledCursor).toBe(1);
    expect(outcome.failed).toBe(true);
  });

  it('fails the run — a livelock guard that only logs is not a guard', () => {
    const issues = emptyIssues();
    issues.stalledCursor = 1;

    expect(() => assertPlatformPurgeRunComplete(reportWith(issues, 1)))
      .toThrow(/stalledCursor=1/);
  });
});

describe('the pass ceiling', () => {
  it('stops a domain that never finishes, and fails the run for it', async () => {
    let cursor = 0;
    h.makeServiceRequest.mockImplementation(async () => {
      cursor += 1;
      return pass({
        nextCursor: `6a2f9d8989b795cfdfac${String(3500 + cursor).padStart(4, '0')}`,
        done: false,
      });
    });
    const issues = emptyIssues();

    const outcome = await purgeDomainOnPlatform(DOMAIN, options({ maxPassesPerDomain: 4 }), issues);

    expect(issuedRequests()).toHaveLength(4);
    expect(outcome.passes).toBe(4);
    expect(outcome.done).toBe(false);
    expect(issues.passCeilingReached).toBe(1);
    expect(() => assertPlatformPurgeRunComplete(reportWith(issues, 1)))
      .toThrow(/passCeilingReached=1/);
  });
});

describe('a disagreement between the two ends', () => {
  it('aborts the whole run when Oxy reports a different mode', async () => {
    const domains = new Set([DOMAIN, 'other.example']);
    respondWith(pass({ dryRun: false }));

    const report = await purgeBlockedDomainPlatformData(domains, options({ dryRun: true }));

    expect(report.issues.dryRunMismatch).toBe(1);
    expect(report.issues.abortedEarly).toBe(1);
    // One domain asked, one domain answered wrong, nothing else attempted.
    expect(issuedRequests()).toHaveLength(1);
    expect(() => assertPlatformPurgeRunComplete(report)).toThrow(/dryRunMismatch=1/);
  });

  it('raises a mode disagreement as its own error, not a generic failure', async () => {
    respondWith(pass({ dryRun: true }));

    await expect(purgeDomainOnPlatform(DOMAIN, options({ dryRun: false }), emptyIssues()))
      .rejects.toBeInstanceOf(DryRunViolationError);
  });

  it('refuses a domain Oxy canonicalised differently', async () => {
    respondWith(pass({ canonicalDomain: 'other.example', nextCursor: OBJECT_IDS[0], done: false }));
    const issues = emptyIssues();

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), issues);

    // Both ends canonicalise with @oxyhq/federation. If they disagree, the purge
    // is aimed at a host we never named — the one direction that is not undoable.
    expect(issuedRequests()).toHaveLength(1);
    expect(issues.canonicalDomainMismatch).toBe(1);
    expect(outcome.failed).toBe(true);
    expect(outcome.actorsProcessed).toBe(0);
  });

  it('counts nothing from the pass it refused', async () => {
    respondWith(pass({
      canonicalDomain: 'other.example',
      actorsDeleted: 7,
      localFollowersAffected: 3,
      done: true,
    }));

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), emptyIssues());

    expect(outcome.actorsDeleted).toBe(0);
    expect(outcome.localFollowersAffected).toBe(0);
  });
});

describe('a response that cannot be read', () => {
  it.each([
    ['a missing counter', { ...pass(), localFollowersAffected: undefined }],
    ['a counter that is not a number', { ...pass(), actorsDeleted: '4' }],
    ['a negative counter', { ...pass(), filesDeleted: -1 }],
    ['a missing done flag', { ...pass(), done: undefined }],
    ['a nextCursor that is not an object id', { ...pass(), nextCursor: 'not-an-id' }],
    ['a retained actor with no referencedByAppIds', { ...pass(), actorsRetained: [{ oxyUserId: 'x' }] }],
    ['a body that is not an object', 'ok'],
  ])('rejects %s', (_label, body) => {
    expect(() => parseDomainPurgePass(body)).toThrow(MalformedPurgeResponseError);
  });

  it('reads a well-formed pass, including who kept a row alive', () => {
    const parsed = parseDomainPurgePass(pass({
      actorsRetained: [
        { oxyUserId: 'a', username: 'one', referencedByAppIds: ['app-1'] },
        { oxyUserId: 'b', username: 'two', referencedByAppIds: ['app-1', 'app-2'] },
      ],
      localFollowersAffected: 3,
      bytesDeleted: 2048,
      nextCursor: OBJECT_IDS[0],
      done: false,
    }));

    expect(parsed.actorsRetained).toBe(2);
    expect(parsed.retainedByAppIds).toEqual(['app-1', 'app-2']);
    expect(parsed.localFollowersAffected).toBe(3);
    expect(parsed.nextCursor).toBe(OBJECT_IDS[0]);
    expect(parsed.done).toBe(false);
  });

  it('is counted apart from a transport failure and fails the run', async () => {
    respondWith({ ...pass(), remaining: undefined });
    const issues = emptyIssues();

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), issues);

    expect(issues.malformedResponse).toBe(1);
    expect(issues.requestFailed).toBe(0);
    expect(outcome.failed).toBe(true);
    expect(() => assertPlatformPurgeRunComplete(reportWith(issues, 1)))
      .toThrow(/malformedResponse=1/);
  });
});

describe('a candidate Oxy refused after fetching it', () => {
  it('fails the run — it means the query is wider than the canonical rule', async () => {
    respondWith(pass({ candidatesRejected: 1, actorsProcessed: 1, done: true }));
    const issues = emptyIssues();

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), issues);

    expect(outcome.candidatesRejected).toBe(1);
    expect(issues.candidatesRejected).toBe(1);
    expect(() => assertPlatformPurgeRunComplete(reportWith(issues, 1)))
      .toThrow(/candidatesRejected=1/);
  });
});

describe('a failing request', () => {
  it('does not strand the domains behind it', async () => {
    const domains = new Set(['a.example', 'b.example', 'c.example']);
    let call = 0;
    h.makeServiceRequest.mockImplementation(async (_method, _path, request) => {
      call += 1;
      if (call === 1) throw { message: 'Bad Gateway', status: 502 };
      return pass({ canonicalDomain: (request as DomainPurgeRequest).domain });
    });

    const report = await purgeBlockedDomainPlatformData(domains, options());

    expect(report.domainsVisited).toBe(3);
    expect(report.issues.requestFailed).toBe(1);
    expect(report.outcomes.filter((outcome) => outcome.done)).toHaveLength(2);
  });

  it('is tolerated below the stated rate and fails the run above it', () => {
    const scattered = emptyIssues();
    scattered.requestFailed = 5;
    expect(() => assertPlatformPurgeRunComplete(reportWith(scattered, 118))).not.toThrow();

    const systemic = emptyIssues();
    systemic.requestFailed = 12;
    expect(() => assertPlatformPurgeRunComplete(reportWith(systemic, 118)))
      .toThrow(/requestFailed=12/);
  });

  it('stops the run once five domains in a row have failed', async () => {
    const domains = new Set(
      Array.from({ length: 9 }, (_unused, index) => `d${index}.example`),
    );
    h.makeServiceRequest.mockRejectedValue({ message: 'Unauthorized', status: 401 });

    const report = await purgeBlockedDomainPlatformData(domains, options());

    // A bad credential fails every domain identically; the fifth identical
    // failure is not new information, and four more requests would be noise
    // aimed at production.
    expect(report.domainsVisited).toBe(5);
    expect(issuedRequests()).toHaveLength(5);
    expect(report.issues.abortedEarly).toBe(1);
    expect(() => assertPlatformPurgeRunComplete(report)).toThrow(/abortedEarly=1/);
  });

  it('keeps sweeping when failures are scattered rather than consecutive', async () => {
    const domains = new Set(
      Array.from({ length: 9 }, (_unused, index) => `d${index}.example`),
    );
    let call = 0;
    h.makeServiceRequest.mockImplementation(async (_method, _path, request) => {
      call += 1;
      if (call % 2 === 1) throw { message: 'Bad Gateway', status: 502 };
      return pass({ canonicalDomain: (request as DomainPurgeRequest).domain });
    });

    const report = await purgeBlockedDomainPlatformData(domains, options());

    expect(report.domainsVisited).toBe(9);
    expect(report.issues.abortedEarly).toBe(0);
  });
});

describe('the domains that may be sent', () => {
  it('are exactly the committed policy, canonicalised', () => {
    const policy = getBlockedDomainPolicy().map((entry) => entry.domain);

    expect([...resolvePurgeTargets(options())].sort()).toEqual([...policy].sort());
  });

  it('never include a domain that is not in the policy', async () => {
    const policy = new Set(getBlockedDomainPolicy().map((entry) => entry.domain));
    h.makeServiceRequest.mockImplementation(async (_method, _path, request) =>
      pass({ canonicalDomain: (request as DomainPurgeRequest).domain }));

    await purgeBlockedDomainPlatformData(resolvePurgeTargets(options()), options());

    expect(issuedRequests()).not.toHaveLength(0);
    const sent = issuedRequests().map((request) => request.domain);
    expect(sent.filter((domain) => !policy.has(domain))).toEqual([]);
  });

  it('refuse a narrowed run aimed at a domain the policy does not name', () => {
    expect(() => resolvePurgeTargets(options({ domain: 'never-blocked.example' })))
      .toThrow(EmptyBlocklistError);
  });

  it('narrow to the one requested policy domain', () => {
    const [first] = getBlockedDomainPolicy();

    expect([...resolvePurgeTargets(options({ domain: first.domain }))]).toEqual([first.domain]);
  });
});

describe('the report', () => {
  it('leads with the local followers a purge costs', async () => {
    respondWith(
      pass({ nextCursor: OBJECT_IDS[0], done: false, localFollowersAffected: 2, actorsProcessed: 2 }),
      pass({ nextCursor: OBJECT_IDS[1], done: true, localFollowersAffected: 3, actorsProcessed: 1 }),
    );

    const outcome = await purgeDomainOnPlatform(DOMAIN, options(), emptyIssues());

    expect(outcome.localFollowersAffected).toBe(5);
  });

  it('puts local followers first in the totals and in the table', () => {
    const report = reportWith(emptyIssues(), 2);
    report.outcomes = [
      { ...outcomeFor('quiet.example'), done: true, actorsProcessed: 9, actorsDeleted: 9 },
      {
        ...outcomeFor('loud.example'),
        done: true,
        actorsProcessed: 1,
        actorsDeleted: 1,
        localFollowersAffected: 4,
      },
    ];

    expect(Object.keys(totalsOf(report))[0]).toBe('localFollowersAffected');
    expect(totalsOf(report).localFollowersAffected).toBe(4);

    const table = renderDomainTable(report);
    expect(table[0]?.split(/\s+/).slice(0, 2)).toEqual(['DOMAIN', 'FOLLOWERS']);
    // Ranked by the human cost, not by the inventory: the domain with more rows
    // but nobody following it does not lead the table.
    expect(table[1]).toContain('loud.example');
    expect(table[2]).toContain('quiet.example');
  });

  it('shows an unfinished domain even when it touched nothing', () => {
    const report = reportWith(emptyIssues(), 2);
    report.outcomes = [
      { ...outcomeFor('empty.example'), done: true },
      { ...outcomeFor('broken.example'), failed: true, passes: 1 },
    ];

    const table = renderDomainTable(report);

    expect(table.join('\n')).toContain('broken.example');
    expect(table.join('\n')).not.toContain('empty.example');
  });

  it('says so plainly when nothing was left to remove', () => {
    const report = reportWith(emptyIssues(), 1);
    report.outcomes = [{ ...outcomeFor('empty.example'), done: true }];

    expect(renderDomainTable(report)).toEqual([
      'no blocked domain had anything left on the platform',
    ]);
  });
});

/** A report carrying nothing but the issues and the denominator under test. */
function reportWith(issues: PlatformPurgeReport['issues'], domainsVisited: number): PlatformPurgeReport {
  return { dryRun: true, domainsVisited, outcomes: [], issues };
}

function outcomeFor(domain: string): PlatformPurgeReport['outcomes'][number] {
  return {
    domain,
    passes: 1,
    done: false,
    failed: false,
    localFollowersAffected: 0,
    actorsProcessed: 0,
    actorsDeleted: 0,
    actorsRetained: 0,
    retainedByAppIds: [],
    filesDeleted: 0,
    bytesDeleted: 0,
    avatarsDeleted: 0,
    followEdgesRemoved: 0,
    candidatesRejected: 0,
    remaining: 0,
  };
}
