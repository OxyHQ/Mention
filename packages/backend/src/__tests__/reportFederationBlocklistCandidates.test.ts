import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Offline, model-level tests for the federation blocklist INTELLIGENCE report.
 *
 * `signedFetch` (the SSRF-safe transport the AP connector uses) and the three
 * models the report reads are mocked over small in-memory stores, so the REAL
 * source polling, corroboration threshold, severity separation and local-impact
 * counting run WITHOUT MongoDB or a network — mirroring the convention from
 * `backfillFederatedBoostCounts.test.ts` (the repo has no `mongodb-memory-server`
 * and globally mocks mongoose).
 *
 * The transport is mocked at the MODULE, not injected, so these tests exercise
 * the same `signedFetch` call the production path makes — including the 404
 * "this instance does not publish" branch, which is the one a hand-rolled
 * `fetch` seam would let drift.
 */

interface StoredActor {
  _id: mongoose.Types.ObjectId;
  domain: string;
  oxyUserId?: string | null;
}

interface StoredFollow {
  _id: mongoose.Types.ObjectId;
  localUserId: string;
  remoteActorUri: string;
  direction: 'outbound' | 'inbound';
  status: 'accepted' | 'pending';
}

interface StoredPost {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
}

/** What a mocked source answers when polled. */
type SourceResponse =
  | { status: number; body: unknown }
  | { throws: Error }
  /** Never settles — exercises the per-source timeout. */
  | { hangs: true };

const h = vi.hoisted(() => {
  const state: {
    actors: StoredActor[];
    follows: StoredFollow[];
    posts: StoredPost[];
    responses: Map<string, SourceResponse>;
    blockedLocally: Set<string>;
  } = {
    actors: [],
    follows: [],
    posts: [],
    responses: new Map(),
    blockedLocally: new Set(),
  };
  return {
    state,
    signedFetch: vi.fn(),
    isBlockedDomain: vi.fn(),
    actorFind: vi.fn(),
    actorAggregate: vi.fn(),
    followFind: vi.fn(),
    postCountDocuments: vi.fn(),
  };
});

vi.mock('../connectors/activitypub/helpers', async () => {
  const actual = await vi.importActual<typeof import('../connectors/activitypub/helpers')>(
    '../connectors/activitypub/helpers',
  );
  return { runWithTimeout: actual.runWithTimeout, signedFetch: h.signedFetch };
});

vi.mock('../connectors/activitypub/constants', () => ({
  isBlockedDomain: h.isBlockedDomain,
}));

vi.mock('../models/FederatedActor', () => ({
  FederatedActor: { find: h.actorFind, aggregate: h.actorAggregate },
}));

vi.mock('../models/FederatedFollow', () => ({
  FederatedFollow: { find: h.followFind },
}));

vi.mock('../models/Post', () => ({
  Post: { countDocuments: h.postCountDocuments },
}));

import {
  buildCorroboration,
  buildDigestIndex,
  corroboratingSourceCount,
  corroboratingSourceNames,
  parseDomainBlocks,
  renderReportTable,
  reportFederationBlocklistCandidates,
  type SourceObservation,
  type SourcePollResult,
} from '../scripts/reportFederationBlocklistCandidates';

/** Ascending, stable ids so the paged cursors in the script behave like Mongo's. */
let idCounter = 0;
function nextId(): mongoose.Types.ObjectId {
  idCounter += 1;
  return new mongoose.Types.ObjectId(idCounter.toString(16).padStart(24, '0'));
}

/** A Mastodon `/api/v1/instance/domain_blocks` entry. */
function block(
  domain: string,
  severity: string,
  comment?: string,
  digest?: string,
): Record<string, unknown> {
  return { domain, severity, comment, digest };
}

/** Page a store by the ascending `_id` cursor the script uses. */
function pageBy<T extends { _id: mongoose.Types.ObjectId }>(
  rows: T[],
  query: { _id?: { $gt?: mongoose.Types.ObjectId } },
  limit: number,
): T[] {
  const gt = query._id?.$gt;
  return rows
    .filter((row) => !gt || row._id.toString() > gt.toString())
    .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
    .slice(0, limit);
}

beforeEach(() => {
  idCounter = 0;
  h.state.actors = [];
  h.state.follows = [];
  h.state.posts = [];
  h.state.responses = new Map();
  h.state.blockedLocally = new Set();

  h.signedFetch.mockReset();
  h.isBlockedDomain.mockReset();
  h.actorFind.mockReset();
  h.actorAggregate.mockReset();
  h.followFind.mockReset();
  h.postCountDocuments.mockReset();

  h.signedFetch.mockImplementation(async (url: string) => {
    const source = new URL(url).host;
    const configured = h.state.responses.get(source);
    if (!configured) throw new Error(`no mocked response for ${source}`);
    if ('throws' in configured) throw configured.throws;
    if ('hangs' in configured) return new Promise<Response>(() => {});
    return {
      status: configured.status,
      ok: configured.status >= 200 && configured.status < 300,
      json: async () => configured.body,
    } as Response;
  });

  h.isBlockedDomain.mockImplementation((domain: string) => h.state.blockedLocally.has(domain));

  h.actorAggregate.mockImplementation(async () => {
    const counts = new Map<string, number>();
    for (const actor of h.state.actors) {
      counts.set(actor.domain, (counts.get(actor.domain) ?? 0) + 1);
    }
    return [...counts].map(([domain, actors]) => ({ _id: domain, actors }));
  });

  h.actorFind.mockImplementation((query: { domain: string; _id?: { $gt?: mongoose.Types.ObjectId } }) => ({
    sort: () => ({
      limit: (n: number) => ({
        lean: async () =>
          pageBy(h.state.actors.filter((actor) => actor.domain === query.domain), query, n),
      }),
    }),
  }));

  h.followFind.mockImplementation((query: { status: string; _id?: { $gt?: mongoose.Types.ObjectId } }) => ({
    sort: () => ({
      limit: (n: number) => ({
        lean: async () =>
          pageBy(h.state.follows.filter((follow) => follow.status === query.status), query, n),
      }),
    }),
  }));

  h.postCountDocuments.mockImplementation(async (query: { oxyUserId: { $in: string[] } }) => {
    const authors = new Set(query.oxyUserId.$in);
    return h.state.posts.filter((post) => authors.has(post.oxyUserId)).length;
  });
});

describe('parseDomainBlocks', () => {
  it('keeps every published severity and drops entries it cannot use', () => {
    const { entries, rejected } = parseDomainBlocks([
      block('spam.example', 'suspend', 'Hate speech'),
      block('quiet.example', 'silence'),
      block('listed.example', 'noop'),
      block('bad.example', 'not-a-severity'),
      // Masked with no digest: unnameable and unmatchable, so unusable.
      { domain: 'exa*****.com', severity: 'suspend' },
      'not-an-object',
    ]);

    expect(entries.map((entry) => [entry.domain, entry.severity])).toEqual([
      ['spam.example', 'suspend'],
      ['quiet.example', 'silence'],
      ['listed.example', 'noop'],
    ]);
    expect(rejected).toBe(3);
  });

  it('keeps a masked entry when a digest can still identify it', () => {
    const digest = 'a'.repeat(64);
    const { entries, rejected } = parseDomainBlocks([
      { domain: 'exa*****.com', severity: 'suspend', digest },
    ]);

    expect(rejected).toBe(0);
    expect(entries[0].obfuscated).toBe(true);
    expect(entries[0].digest).toBe(digest);
  });

  it('yields nothing for a payload that is not an array', () => {
    expect(parseDomainBlocks({ error: 'Record not found' })).toEqual({ entries: [], rejected: 0 });
  });
});

describe('buildCorroboration', () => {
  const published = (source: string, entries: unknown[]): SourcePollResult => ({
    source,
    outcome: 'published',
    status: 200,
    entries: parseDomainBlocks(entries).entries,
    rejectedEntries: 0,
  });

  it('counts DISTINCT sources and never merges suspend with silence', () => {
    const { byDomain } = buildCorroboration(
      [
        published('a.example', [block('spam.example', 'suspend', 'Hate speech')]),
        published('b.example', [block('spam.example', 'silence', 'Spam')]),
        // Same source listing it twice still contributes ONE vote.
        published('c.example', [
          block('spam.example', 'suspend'),
          block('spam.example', 'suspend'),
        ]),
      ],
      new Map(),
    );

    const corroboration = byDomain.get('spam.example');
    expect(corroboration).toBeDefined();
    if (!corroboration) return;
    expect(corroboration.suspendSources).toBe(2);
    expect(corroboration.silenceSources).toBe(1);
    expect(corroboratingSourceCount(corroboration)).toBe(3);
    // Every source's own verdict survives, unmerged.
    expect(corroboration.observations.map((o) => o.severity)).toEqual([
      'suspend',
      'silence',
      'suspend',
      'suspend',
    ]);
  });

  it('never lets a noop listing count as a blocking source', () => {
    const { byDomain } = buildCorroboration(
      [
        published('a.example', [block('listed.example', 'noop')]),
        published('b.example', [block('listed.example', 'noop')]),
      ],
      new Map(),
    );

    const corroboration = byDomain.get('listed.example');
    expect(corroboration).toBeDefined();
    if (!corroboration) return;
    expect(corroboration.noopSources).toBe(2);
    expect(corroboratingSourceCount(corroboration)).toBe(0);
  });

  it('recovers a masked entry from its digest, and counts the ones it cannot', () => {
    const digestIndex = buildDigestIndex(['spam.example']);
    const digest = [...digestIndex.keys()][0];

    const { byDomain, obfuscation } = buildCorroboration(
      [
        published('a.example', [{ domain: 'spa*.example', severity: 'suspend', digest }]),
        published('b.example', [{ domain: 'oth**.example', severity: 'suspend', digest: 'b'.repeat(64) }]),
      ],
      digestIndex,
    );

    expect(obfuscation).toEqual({ seen: 2, resolved: 1, unresolved: 1 });
    expect(byDomain.get('spam.example')?.suspendSources).toBe(1);
    expect(byDomain.get('spam.example')?.observations[0].resolvedFromDigest).toBe(true);
    expect([...byDomain.keys()]).toEqual(['spam.example']);
  });
});

describe('reportFederationBlocklistCandidates', () => {
  const sources = ['a.example', 'b.example', 'c.example'];

  it('treats a source that 404s as "does not publish", not as a failure', async () => {
    h.state.responses.set('a.example', {
      status: 200,
      body: [block('spam.example', 'suspend', 'Hate speech')],
    });
    h.state.responses.set('b.example', { status: 404, body: { error: 'Record not found' } });
    h.state.responses.set('c.example', {
      status: 200,
      body: [block('spam.example', 'suspend', 'Hate speech')],
    });

    const report = await reportFederationBlocklistCandidates({ sources });

    const outcomes = Object.fromEntries(report.sources.map((s) => [s.source, s.outcome]));
    expect(outcomes).toEqual({
      'a.example': 'published',
      'b.example': 'not-published',
      'c.example': 'published',
    });
    // The 404 did not abort the run: the other two still corroborated.
    expect(report.candidates.map((c) => c.domain)).toEqual(['spam.example']);
    expect(report.candidates[0].sourceCount).toBe(2);
  });

  it('separates a transport failure and a timeout from "does not publish"', async () => {
    h.state.responses.set('a.example', { throws: new Error('ECONNREFUSED') });
    h.state.responses.set('b.example', { hangs: true });
    h.state.responses.set('c.example', { status: 403, body: null });

    const report = await reportFederationBlocklistCandidates({ sources, sourceTimeoutMs: 10 });

    expect(report.sources.map((s) => [s.source, s.outcome])).toEqual([
      ['a.example', 'failed'],
      ['b.example', 'failed'],
      ['c.example', 'not-published'],
    ]);
    expect(report.sources[0].detail).toContain('ECONNREFUSED');
    expect(report.sources[1].detail).toContain('10ms');
    expect(report.candidates).toEqual([]);
  });

  it('excludes a single-source hit and includes a two-source one', async () => {
    h.state.responses.set('a.example', {
      status: 200,
      body: [block('one.example', 'suspend'), block('two.example', 'suspend')],
    });
    h.state.responses.set('b.example', { status: 200, body: [block('two.example', 'suspend')] });
    h.state.responses.set('c.example', { status: 200, body: [] });

    const report = await reportFederationBlocklistCandidates({ sources });

    expect(report.minSources).toBe(2);
    expect(report.candidates.map((c) => c.domain)).toEqual(['two.example']);
    expect(report.domainsObserved).toBe(2);
    expect(report.domainsBelowThreshold).toBe(1);
  });

  it('honours a raised threshold, dropping a domain only two sources block', async () => {
    h.state.responses.set('a.example', {
      status: 200,
      body: [block('two.example', 'suspend'), block('three.example', 'suspend')],
    });
    h.state.responses.set('b.example', {
      status: 200,
      body: [block('two.example', 'suspend'), block('three.example', 'suspend')],
    });
    h.state.responses.set('c.example', { status: 200, body: [block('three.example', 'suspend')] });

    const report = await reportFederationBlocklistCandidates({ sources, minSources: 3 });

    expect(report.candidates.map((c) => c.domain)).toEqual(['three.example']);
    expect(report.domainsBelowThreshold).toBe(1);
  });

  it('keeps suspend and silence separate on the candidate it reports', async () => {
    h.state.responses.set('a.example', { status: 200, body: [block('mixed.example', 'suspend', 'Hate speech')] });
    h.state.responses.set('b.example', { status: 200, body: [block('mixed.example', 'silence', 'Untagged porn')] });
    h.state.responses.set('c.example', { status: 200, body: [block('mixed.example', 'noop')] });

    const report = await reportFederationBlocklistCandidates({ sources });

    const candidate = report.candidates[0];
    expect(candidate.suspendSources).toBe(1);
    expect(candidate.silenceSources).toBe(1);
    expect(candidate.noopSources).toBe(1);
    // The noop listing is reported but never counted toward the threshold.
    expect(candidate.sourceCount).toBe(2);
    expect(candidate.observations.map((o) => o.comment)).toEqual([
      'Hate speech',
      'Untagged porn',
      undefined,
    ]);
  });

  it('measures what a block would cost us, and ranks by it', async () => {
    for (const source of sources) {
      h.state.responses.set(source, {
        status: 200,
        body: [block('loud.example', 'suspend', 'Hate speech'), block('quiet.example', 'suspend')],
      });
    }

    // loud.example: two actors, three posts, one local follower relationship.
    h.state.actors = [
      { _id: nextId(), domain: 'loud.example', oxyUserId: 'author-1' },
      { _id: nextId(), domain: 'loud.example', oxyUserId: 'author-2' },
      // An actor that never resolved to an Oxy user: no posts attributable.
      { _id: nextId(), domain: 'loud.example', oxyUserId: null },
      { _id: nextId(), domain: 'unrelated.example', oxyUserId: 'author-3' },
    ];
    h.state.posts = [
      { _id: nextId(), oxyUserId: 'author-1' },
      { _id: nextId(), oxyUserId: 'author-1' },
      { _id: nextId(), oxyUserId: 'author-2' },
      { _id: nextId(), oxyUserId: 'author-3' },
    ];
    h.state.follows = [
      {
        _id: nextId(),
        localUserId: 'local-1',
        remoteActorUri: 'https://loud.example/users/one',
        direction: 'outbound',
        status: 'accepted',
      },
      {
        _id: nextId(),
        localUserId: 'local-2',
        remoteActorUri: 'https://loud.example/users/two',
        direction: 'outbound',
        status: 'accepted',
      },
      // Inbound: a remote account there follows one of our users.
      {
        _id: nextId(),
        localUserId: 'local-3',
        remoteActorUri: 'https://loud.example/users/three',
        direction: 'inbound',
        status: 'accepted',
      },
      // Pending, so not a follow anyone would lose.
      {
        _id: nextId(),
        localUserId: 'local-4',
        remoteActorUri: 'https://loud.example/users/four',
        direction: 'outbound',
        status: 'pending',
      },
    ];

    const report = await reportFederationBlocklistCandidates({ sources });

    // Ranked by OUR cost, not by source count (both have three sources).
    expect(report.candidates.map((c) => c.domain)).toEqual(['loud.example', 'quiet.example']);
    expect(report.candidates[0].footprint).toEqual({
      actors: 3,
      actorsWithoutLocalUser: 1,
      posts: 3,
      localUsersFollowing: 2,
      remoteActorsFollowed: 2,
      localUsersFollowed: 1,
    });
    expect(report.candidates[1].footprint).toEqual({
      actors: 0,
      actorsWithoutLocalUser: 0,
      posts: 0,
      localUsersFollowing: 0,
      remoteActorsFollowed: 0,
      localUsersFollowed: 0,
    });
  });

  it('counts a follow whose actor row we no longer hold', async () => {
    for (const source of sources) {
      h.state.responses.set(source, { status: 200, body: [block('pruned.example', 'suspend')] });
    }
    // No FederatedActor row for pruned.example at all — but a local user still
    // follows an account there, and that follow is still a loss.
    h.state.follows = [
      {
        _id: nextId(),
        localUserId: 'local-1',
        remoteActorUri: 'https://pruned.example/users/gone',
        direction: 'outbound',
        status: 'accepted',
      },
    ];

    const report = await reportFederationBlocklistCandidates({ sources });

    expect(report.candidates[0].footprint.actors).toBe(0);
    expect(report.candidates[0].footprint.localUsersFollowing).toBe(1);
  });

  it('marks a candidate our own policy already rejects', async () => {
    for (const source of sources) {
      h.state.responses.set(source, { status: 200, body: [block('known.example', 'suspend')] });
    }
    h.state.blockedLocally.add('known.example');

    const report = await reportFederationBlocklistCandidates({ sources });

    expect(report.candidates[0].blockedLocally).toBe(true);
  });

  it('recovers a source that MASKS a domain another source names in plain', async () => {
    const digest = createHash('sha256').update('spam.example').digest('hex');
    // We hold nothing from spam.example, so the corpus alone cannot name it —
    // only the cross-seed from a.example's plain listing can.
    h.state.responses.set('a.example', { status: 200, body: [block('spam.example', 'suspend', 'Hate speech')] });
    h.state.responses.set('b.example', {
      status: 200,
      body: [{ domain: 'spa*.example', severity: 'suspend', comment: 'Hate speech', digest }],
    });
    h.state.responses.set('c.example', { status: 200, body: [] });

    const report = await reportFederationBlocklistCandidates({ sources });

    expect(report.obfuscatedEntries).toBe(1);
    expect(report.obfuscatedResolved).toBe(1);
    expect(report.candidates.map((c) => c.domain)).toEqual(['spam.example']);
    // Without the cross-seed this reads as a single-source opinion and is dropped.
    expect(report.candidates[0].sourceCount).toBe(2);
    expect(report.candidates[0].observations.map((o) => o.resolvedFromDigest)).toEqual([false, true]);
  });

  it('polls the SSRF-safe transport at the published Mastodon endpoint', async () => {
    for (const source of sources) h.state.responses.set(source, { status: 200, body: [] });

    await reportFederationBlocklistCandidates({ sources });

    expect(h.signedFetch.mock.calls.map((call) => call[0])).toEqual([
      'https://a.example/api/v1/instance/domain_blocks',
      'https://b.example/api/v1/instance/domain_blocks',
      'https://c.example/api/v1/instance/domain_blocks',
    ]);
  });
});

describe('corroboratingSourceNames', () => {
  /**
   * The committed policy's `corroboratingSources` is a list of NAMES, and the
   * page publishes it as who else independently reached the same decision. A
   * report that only ever said `suspend×3` could not fill that field: the only
   * ways to write it from a count are to invent names or to leave it empty, and
   * leaving it empty makes the page state the decision was Mention's alone.
   */
  function observed(
    source: string,
    severity: SourceObservation['severity'],
    resolvedFromDigest = false,
  ): SourceObservation {
    return { source, severity, resolvedFromDigest };
  }

  it('names the sources at one severity, sorted, and no others', () => {
    const names = corroboratingSourceNames(
      [
        observed('zeta.example', 'suspend'),
        observed('alpha.example', 'suspend'),
        observed('silencer.example', 'silence'),
        observed('lister.example', 'noop'),
      ],
      'suspend',
    );

    expect(names).toEqual(['alpha.example', 'zeta.example']);
  });

  it('votes once per source, so the names agree with the count', () => {
    // A source that lists the same domain twice contributes ONE vote to
    // `sourceCount`. If it contributed two names, a reviewer transcribing the
    // list into the policy would publish corroboration that does not exist.
    const observations = [
      observed('a.example', 'suspend'),
      observed('a.example', 'suspend'),
      observed('b.example', 'suspend'),
    ];

    expect(corroboratingSourceNames(observations, 'suspend')).toEqual(['a.example', 'b.example']);
  });

  it('says which names were recovered from a digest rather than read', () => {
    // A masked entry counts identically, but a digest match is only as good as
    // the domain list that seeded it — so the reader is told which is which.
    expect(
      corroboratingSourceNames([observed('masked.example', 'suspend', true)], 'suspend'),
    ).toEqual(['masked.example(masked)']);

    // One plain publication is a name we read directly, whatever else that
    // source published masked.
    expect(
      corroboratingSourceNames(
        [observed('mixed.example', 'suspend', true), observed('mixed.example', 'suspend', false)],
        'suspend',
      ),
    ).toEqual(['mixed.example']);
  });
});

describe('renderReportTable', () => {
  it('renders each candidate once and says how many it omitted', async () => {
    const sources = ['a.example', 'b.example'];
    for (const source of sources) {
      h.state.responses.set(source, {
        status: 200,
        body: [block('one.example', 'suspend', 'Hate speech'), block('two.example', 'silence')],
      });
    }

    const report = await reportFederationBlocklistCandidates({ sources });
    const lines = renderReportTable(report, 1);

    expect(lines[0]).toContain('DOMAIN');
    expect(lines[1]).toContain('one.example');
    // NAMED, not counted — this row is what a reviewer transcribes a policy
    // entry's `corroboratingSources` from.
    expect(lines[1]).toContain('suspend[a.example b.example]');
    expect(lines[1]).toContain('Hate speech');
    expect(lines[2]).toContain('1 further candidates omitted');
  });

  it('says so plainly when nothing reached the threshold', () => {
    expect(
      renderReportTable({
        minSources: 2,
        sources: [],
        domainsObserved: 0,
        domainsBelowThreshold: 0,
        obfuscatedEntries: 0,
        obfuscatedResolved: 0,
        obfuscatedUnresolved: 0,
        candidates: [],
      }),
    ).toEqual(['no domain reached 2 corroborating sources']);
  });
});

describe('read-only guarantee', () => {
  /**
   * The whole point of this script is that it never enforces anything. That
   * property is not something a reviewer can keep re-checking by eye, so it is
   * a gate: the source may not contain a Mongo write, and may not touch the
   * blocked-domain configuration.
   *
   * Mutation-tested — inserting any one of these calls into the script makes
   * this test fail by name.
   */
  const SCRIPT = path.resolve(__dirname, '../scripts/reportFederationBlocklistCandidates.ts');
  const WRITE_CALLS = [
    'bulkWrite',
    'updateOne',
    'updateMany',
    'insertOne',
    'insertMany',
    'deleteOne',
    'deleteMany',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findByIdAndUpdate',
    'replaceOne',
    'create(',
    '.save(',
  ];

  it('performs no database write and never touches the block configuration', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    // Vacuity floor: a scanner that read the wrong (or an empty) file would
    // report a clean pass for every pattern below.
    expect(source.length).toBeGreaterThan(5_000);
    expect(source).toContain('reportFederationBlocklistCandidates');

    const found = WRITE_CALLS.filter((call) => source.includes(call));
    expect(found).toEqual([]);

    // `isBlockedDomain` is READ (to mark decisions already made); the
    // configuration itself must never be assigned.
    expect(source).not.toMatch(/FEDERATION_BLOCKED_DOMAINS\s*=/);
    expect(source).not.toMatch(/blockedDomains\s*(?:=|\.(?:add|push))/);
  });
});
