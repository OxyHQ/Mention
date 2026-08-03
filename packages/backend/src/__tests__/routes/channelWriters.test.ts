import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyAuthRequest } from '@oxyhq/core/server';

/**
 * `GET /channels/:oxyUserId/writers` — the list behind a channel's writers tab.
 *
 * The gate IS the feature, so most of this file is about refusing. Three
 * conditions have to hold and each fails closed: the account resolves as a
 * CHANNEL, its settings say `signPosts === true`, and this reader may see the
 * channel at all. Every refusal is the same 404, so a caller cannot use the
 * status code to learn which condition failed.
 *
 * Two properties get asserted on the refusal path that a status-code check alone
 * would miss:
 *
 *  - the aggregation is NEVER RUN when the gate refuses, so the set is not merely
 *    withheld from the response — it is never computed. A leak cannot come from
 *    somewhere the ids were never loaded.
 *  - the real `channelWriterDisclosure` is used (only the `UserSettings` model is
 *    mocked), so these are tests of the actual gate rather than of a stub that
 *    agrees with it.
 *
 * The `Post.aggregate` mock EXECUTES the pipeline against fixture documents
 * instead of returning canned rows. Without that, every assertion about which
 * posts count — public, published, owned by this channel, carrying a writer —
 * would be an assertion about the mock, and deleting any of those `$match` terms
 * would leave this suite green.
 */

const CHANNEL_ID = 'oxy-channel';
const OTHER_ACCOUNT_ID = 'oxy-other-account';
const VIEWER_ID = 'oxy-viewer';
const WRITER_A = 'oxy-writer-aaa';
const WRITER_B = 'oxy-writer-bbb';
const WRITER_C = 'oxy-writer-ccc';
const GHOST_WRITER = 'oxy-writer-ghost';

const {
  userSettingsFind,
  userSettingsFindOne,
  postAggregate,
  resolveUserSummaries,
  checkFollowAccess,
} = vi.hoisted(() => ({
  userSettingsFind: vi.fn(),
  userSettingsFindOne: vi.fn(),
  postAggregate: vi.fn(),
  resolveUserSummaries: vi.fn(),
  checkFollowAccess: vi.fn(),
}));

vi.mock('../../models/UserSettings', () => {
  const model = {
    find: (...args: unknown[]) => {
      const rows = userSettingsFind(...args);
      const chain = { select: () => chain, lean: async () => rows };
      return chain;
    },
    findOne: (...args: unknown[]) => {
      const row = userSettingsFindOne(...args);
      const chain = { select: () => chain, lean: async () => row };
      return chain;
    },
  };
  return { UserSettings: model, default: model };
});

vi.mock('../../models/Post', () => {
  const model = {
    aggregate: (...args: unknown[]) => {
      const rows = postAggregate(...args);
      const chain = { option: () => chain, exec: async () => rows };
      return chain;
    },
  };
  return { Post: model, default: model };
});

// Only the identity RESOLVER is stubbed. `degradedActorSummary` is left REAL
// (the route imports it from its owning module), so a change to the degraded
// shape breaks the ghost-handle test rather than being masked by a stub.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

vi.mock('../../utils/privacyHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/privacyHelpers')>();
  return {
    // `requiresAccessCheck` stays REAL — it is the pure half of the visibility
    // rule, and stubbing it would make the private-channel cases test nothing.
    requiresAccessCheck: actual.requiresAccessCheck,
    checkFollowAccess: (...args: unknown[]) => checkFollowAccess(...args),
  };
});

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: vi.fn(() => ({})),
}));

import channelWritersRouter from '../../routes/channelWriters.routes';

/* ------------------------------------------------------------------------- */
/* A minimal aggregation engine, covering exactly the stages the route builds. */
/* ------------------------------------------------------------------------- */

/**
 * `type`, not `interface`, on purpose: a type alias carries an implicit index
 * signature, so a fixture is assignable to the `Record<string, unknown>` the
 * evaluator reads without a cast anywhere in this file.
 */
type PostFixture = {
  oxyUserId: string;
  visibility: string;
  status: string;
  writtenByOxyUserId?: string | null;
  createdAt: Date;
};

/**
 * `_id` is `string | null` because that is what Mongo produces: a `$group` keyed
 * on a field some documents lack yields a `null` group rather than dropping them.
 * Modelling that faithfully is what makes the `{ $type: 'string' }` term in the
 * route's `$match` testable — an evaluator that quietly skipped non-string
 * writers would agree with the route whether or not that term were there.
 */
type GroupedRow = {
  _id: string | null;
  lastPostAt: Date;
};

/** Both sides are always the same kind here — Date against Date, string against string. */
function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
  return String(x) < String(y) ? -1 : 1;
}

/** Equality, `{ $type: 'string' }`, `{ $lt: v }`, and a top-level `$or`. */
function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') {
      if (!Array.isArray(condition)) throw new Error('$or expects an array');
      return condition.some((clause) => matches(doc, clause));
    }
    const value = doc[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([op, operand]) => {
        if (op === '$type') return operand === 'string' && typeof value === 'string';
        if (op === '$lt') return value !== undefined && compare(value, operand) < 0;
        throw new Error(`unsupported operator ${op}`);
      });
    }
    return compare(value, condition) === 0;
  });
}

/** Run the route's pipeline over `docs`. Throws on any stage it does not know. */
function runPipeline(docs: PostFixture[], pipeline: Array<Record<string, unknown>>): GroupedRow[] {
  let matched: PostFixture[] = docs;
  let grouped: GroupedRow[] | null = null;

  for (const stage of pipeline) {
    const entry = Object.entries(stage)[0];
    if (!entry) throw new Error('empty pipeline stage');
    const [name, spec] = entry;

    if (name === '$limit') {
      if (typeof spec !== 'number') throw new Error('$limit expects a number');
      if (!grouped) throw new Error('$limit before $group');
      grouped = grouped.slice(0, spec);
      continue;
    }
    if (typeof spec !== 'object' || spec === null) throw new Error(`bad spec for ${name}`);
    const fields: Record<string, unknown> = { ...spec };

    switch (name) {
      case '$match': {
        if (grouped) {
          grouped = grouped.filter((row) => matches({ ...row }, fields));
        } else {
          matched = matched.filter((doc) => matches({ ...doc }, fields));
        }
        break;
      }
      case '$group': {
        expect(fields._id).toBe('$writtenByOxyUserId');
        expect(fields.lastPostAt).toEqual({ $max: '$createdAt' });
        const byWriter = new Map<string | null, Date>();
        for (const doc of matched) {
          // Mongo's own semantics: a missing field groups under `null`, and so
          // does an explicit `null`. Neither is dropped.
          const writer = typeof doc.writtenByOxyUserId === 'string' ? doc.writtenByOxyUserId : null;
          const current = byWriter.get(writer);
          if (!current || doc.createdAt > current) byWriter.set(writer, doc.createdAt);
        }
        grouped = [...byWriter].map(([_id, lastPostAt]) => ({ _id, lastPostAt }));
        break;
      }
      case '$sort': {
        if (!grouped) throw new Error('$sort before $group');
        const keys = Object.entries(fields);
        grouped = [...grouped].sort((a, b) => {
          for (const [key, direction] of keys) {
            if (typeof direction !== 'number') throw new Error('$sort expects 1 or -1');
            const result = compare({ ...a }[key], { ...b }[key]);
            if (result !== 0) return result * direction;
          }
          return 0;
        });
        break;
      }
      default:
        throw new Error(`unsupported stage ${name}`);
    }
  }

  if (!grouped) throw new Error('pipeline produced no group stage');
  return grouped;
}

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* ------------------------------------------------------------------------- */

function post(overrides: Partial<PostFixture> & { createdAt: Date }): PostFixture {
  return {
    oxyUserId: CHANNEL_ID,
    visibility: 'public',
    status: 'published',
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

/**
 * One post per rule the `$match` enforces, so removing ANY of its terms changes
 * the answer. Each excluded fixture names a writer nobody else names, so its
 * appearance in the response is unambiguous evidence of which clause broke.
 */
const CORPUS: PostFixture[] = [
  // Counts: three public, published posts by two writers.
  post({ writtenByOxyUserId: WRITER_A, createdAt: at('2026-01-01T00:00:00.000Z') }),
  post({ writtenByOxyUserId: WRITER_A, createdAt: at('2026-03-01T00:00:00.000Z') }),
  post({ writtenByOxyUserId: WRITER_B, createdAt: at('2026-02-01T00:00:00.000Z') }),
  // Does NOT count — one excluded fixture per clause.
  post({ writtenByOxyUserId: 'writer-draft', status: 'draft', createdAt: at('2026-06-01T00:00:00.000Z') }),
  post({ writtenByOxyUserId: 'writer-scheduled', status: 'scheduled', createdAt: at('2026-06-02T00:00:00.000Z') }),
  post({ writtenByOxyUserId: 'writer-restricted', status: 'restricted', createdAt: at('2026-06-03T00:00:00.000Z') }),
  post({ writtenByOxyUserId: 'writer-followers', visibility: 'followers_only', createdAt: at('2026-06-04T00:00:00.000Z') }),
  post({ writtenByOxyUserId: 'writer-private', visibility: 'private', createdAt: at('2026-06-05T00:00:00.000Z') }),
  post({ writtenByOxyUserId: 'writer-elsewhere', oxyUserId: OTHER_ACCOUNT_ID, createdAt: at('2026-06-06T00:00:00.000Z') }),
  // No writer at all: an ordinary post by a person signed in as themselves. The
  // `null` shape is the one `$exists: true` would wrongly admit — it is stored by
  // clearing the field with an assignment rather than an `$unset`.
  post({ createdAt: at('2026-06-07T00:00:00.000Z') }),
  post({ writtenByOxyUserId: null, createdAt: at('2026-06-08T00:00:00.000Z') }),
];

const ACCOUNTS: Record<string, { id: string; username: string; name: { displayName: string }; kind: string }> = {
  [CHANNEL_ID]: { id: CHANNEL_ID, username: 'thechannel', name: { displayName: 'The Channel' }, kind: 'channel' },
  [WRITER_A]: { id: WRITER_A, username: 'writera', name: { displayName: 'Writer A' }, kind: 'personal' },
  [WRITER_B]: { id: WRITER_B, username: 'writerb', name: { displayName: 'Writer B' }, kind: 'personal' },
  [WRITER_C]: { id: WRITER_C, username: 'writerc', name: { displayName: 'Writer C' }, kind: 'personal' },
};

/**
 * `null` is an ANONYMOUS reader — deliberately not `undefined`, which a default
 * parameter would silently turn back into a signed-in one.
 */
function buildApp(viewerId: string | null = VIEWER_ID): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
    if (viewerId) req.user = { id: viewerId };
    next();
  });
  app.use('/channels', channelWritersRouter);
  return app;
}

/** `signPosts` for the channel, as the settings collection would answer it. */
function signing(value: unknown): void {
  userSettingsFind.mockReturnValue([{ oxyUserId: CHANNEL_ID, channel: { signPosts: value } }]);
}

describe('GET /channels/:oxyUserId/writers', () => {
  beforeEach(() => {
    userSettingsFind.mockReset();
    userSettingsFindOne.mockReset();
    postAggregate.mockReset();
    resolveUserSummaries.mockReset();
    checkFollowAccess.mockReset();

    signing(true);
    userSettingsFindOne.mockReturnValue(null);
    checkFollowAccess.mockResolvedValue(false);
    postAggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) =>
      runPipeline(CORPUS, pipeline),
    );
    resolveUserSummaries.mockImplementation(async (ids: string[]) => {
      const map = new Map<string, { user: unknown }>();
      for (const id of ids) {
        const account = ACCOUNTS[id];
        if (account) map.set(id, { user: account });
      }
      return map;
    });
  });

  /* --------------------------------------------------------------------- */
  /* The list itself                                                        */
  /* --------------------------------------------------------------------- */

  it('lists the distinct writers of the channel, most recent post first', async () => {
    const res = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(200);

    expect(res.body.data.writers.map((row: { writer: { id: string } }) => row.writer.id)).toEqual([
      // Writer A posted in March, Writer B in February — and A is first even
      // though both have written, which is what "most recent post" means.
      WRITER_A,
      WRITER_B,
    ]);
    expect(res.body.data.writers[0].lastPostAt).toBe('2026-03-01T00:00:00.000Z');
    expect(res.body.data.nextCursor).toBeUndefined();
  });

  /**
   * The ordering decision, isolated.
   *
   * Writer A has TWO posts to Writer B's one, so a "most posts first" ordering
   * puts A first for a different reason than recency does — this fixture makes B
   * the more recent, so the two orderings disagree and only one of them passes.
   */
  it('orders by most recent post, NOT by most posts', async () => {
    postAggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) =>
      runPipeline(
        [
          post({ writtenByOxyUserId: WRITER_A, createdAt: at('2026-01-01T00:00:00.000Z') }),
          post({ writtenByOxyUserId: WRITER_A, createdAt: at('2026-01-02T00:00:00.000Z') }),
          post({ writtenByOxyUserId: WRITER_A, createdAt: at('2026-01-03T00:00:00.000Z') }),
          post({ writtenByOxyUserId: WRITER_B, createdAt: at('2026-05-01T00:00:00.000Z') }),
        ],
        pipeline,
      ),
    );

    const res = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(200);

    expect(res.body.data.writers.map((row: { writer: { id: string } }) => row.writer.id)).toEqual([
      WRITER_B,
      WRITER_A,
    ]);
  });

  /**
   * Every clause of the `$match`, in one assertion.
   *
   * The corpus carries one post per exclusion — a draft, a scheduled post, a
   * moderation-restricted post, a followers-only post, a private post, a post
   * owned by another account, a post with no writer, and a post whose writer
   * field is an explicit `null`. Each names a writer nobody else names, so
   * dropping any single term from the query puts a NAMED stranger in this list.
   */
  it('counts only public, published posts this channel owns that carry a writer', async () => {
    const res = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(200);

    const ids = res.body.data.writers.map((row: { writer: { id: string } }) => row.writer.id);
    expect(ids).toEqual([WRITER_A, WRITER_B]);
    for (const excluded of [
      'writer-draft',
      'writer-scheduled',
      'writer-restricted',
      'writer-followers',
      'writer-private',
      'writer-elsewhere',
    ]) {
      expect(ids).not.toContain(excluded);
    }
    // Vacuity floor: the corpus really did contain every excluded shape, so the
    // assertions above are about the query and not about an empty fixture set.
    expect(CORPUS).toHaveLength(11);
  });

  it('returns an empty list for a disclosing channel that has published nothing signed', async () => {
    postAggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) => runPipeline([], pipeline));

    const res = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(200);

    // The list EXISTS and is empty — a different fact from "there is no list",
    // which is the 404 below.
    expect(res.body.data).toEqual({ writers: [] });
  });

  /* --------------------------------------------------------------------- */
  /* The gate                                                               */
  /* --------------------------------------------------------------------- */

  it('404s when the channel has not opted in', async () => {
    signing(false);

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);

    // Not merely withheld: the writers were never even loaded.
    expect(postAggregate).not.toHaveBeenCalled();
  });

  it('404s when the channel has no settings row at all', async () => {
    userSettingsFind.mockReturnValue([]);

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);
    expect(postAggregate).not.toHaveBeenCalled();
  });

  /**
   * The fixture that tells `signPosts === true` from `Boolean(signPosts)`. Every
   * other gate case here is `true`, `false` or absent, and a loose read agrees
   * with a strict one on all three.
   */
  it('404s on a truthy non-boolean signPosts', async () => {
    signing('false');

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);
    expect(postAggregate).not.toHaveBeenCalled();
  });

  it('404s when the settings lookup fails — it fails CLOSED', async () => {
    userSettingsFind.mockImplementation(() => {
      throw new Error('mongo is down');
    });

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);
    expect(postAggregate).not.toHaveBeenCalled();
  });

  /**
   * The `kind` clause. A settings row saying `signPosts: true` under a PERSONAL
   * account is a row that should not exist, and it must not become consent to
   * publish the ids of everybody who has ever posted through that account.
   */
  it('404s when the account is not a channel, whatever its settings row says', async () => {
    resolveUserSummaries.mockImplementation(async (ids: string[]) => {
      const map = new Map<string, { user: unknown }>();
      for (const id of ids) {
        map.set(id, { user: { ...ACCOUNTS[CHANNEL_ID], id, kind: 'personal' } });
      }
      return map;
    });

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);
    expect(postAggregate).not.toHaveBeenCalled();
  });

  it('404s when the account cannot be resolved at all', async () => {
    resolveUserSummaries.mockResolvedValue(new Map());

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);
    expect(postAggregate).not.toHaveBeenCalled();
  });

  /**
   * A failed identity lookup is a 500, not a 404, and that is deliberate: the
   * settings read has a safe default to fall back on (no consent), while "we do
   * not know what kind of account this is" has none that is not a lie. Both are
   * non-disclosing, which is the property that matters — the writers are never
   * loaded either way.
   */
  it('does not disclose when the identity lookup throws', async () => {
    resolveUserSummaries.mockRejectedValue(new Error('oxy is down'));

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(500);
    expect(postAggregate).not.toHaveBeenCalled();
  });

  /**
   * Every refusal answers the SAME body, so the status code and the message
   * together cannot tell a caller which condition failed — a channel that does
   * not sign, an account that is not a channel and an id that names nothing are
   * one answer.
   */
  it('answers every refusal identically', async () => {
    signing(false);
    const notSigning = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);

    resolveUserSummaries.mockResolvedValue(new Map());
    const unknown = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);

    expect(notSigning.body).toEqual(unknown.body);
  });

  it('400s on a missing or oversized account id', async () => {
    await request(buildApp()).get(`/channels/${'x'.repeat(65)}/writers`).expect(400);
    expect(postAggregate).not.toHaveBeenCalled();
  });

  /* --------------------------------------------------------------------- */
  /* Profile visibility                                                     */
  /* --------------------------------------------------------------------- */

  it('404s a restricted channel for a reader who does not follow it', async () => {
    userSettingsFindOne.mockReturnValue({ privacy: { profileVisibility: 'followers_only' } });
    checkFollowAccess.mockResolvedValue(false);

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(404);
    expect(postAggregate).not.toHaveBeenCalled();
  });

  it('404s a restricted channel for an ANONYMOUS reader, without an upstream call', async () => {
    userSettingsFindOne.mockReturnValue({ privacy: { profileVisibility: 'private' } });

    await request(buildApp(null)).get(`/channels/${CHANNEL_ID}/writers`).expect(404);

    expect(checkFollowAccess).not.toHaveBeenCalled();
    expect(postAggregate).not.toHaveBeenCalled();
  });

  it('serves a restricted channel to a reader who follows it', async () => {
    userSettingsFindOne.mockReturnValue({ privacy: { profileVisibility: 'followers_only' } });
    checkFollowAccess.mockResolvedValue(true);

    const res = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(200);

    expect(res.body.data.writers).toHaveLength(2);
    expect(checkFollowAccess).toHaveBeenCalledWith(VIEWER_ID, CHANNEL_ID, expect.anything());
  });

  it('does not pay for a follow check on an ordinary public channel', async () => {
    userSettingsFindOne.mockReturnValue({ privacy: { profileVisibility: 'public' } });

    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(200);

    expect(checkFollowAccess).not.toHaveBeenCalled();
  });

  /* --------------------------------------------------------------------- */
  /* Identity                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * The ghost-handle rule. A writer Oxy cannot resolve arrives DEGRADED — empty
   * username, `'Unknown user'` — never as a raw `oxyUserId` in a handle position,
   * because `/@<id>` is not a profile.
   */
  it('degrades a writer Oxy cannot resolve, never emitting a raw id as a handle', async () => {
    postAggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) =>
      runPipeline(
        [post({ writtenByOxyUserId: GHOST_WRITER, createdAt: at('2026-04-01T00:00:00.000Z') })],
        pipeline,
      ),
    );

    const res = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(200);

    const [row] = res.body.data.writers;
    expect(row.writer.id).toBe(GHOST_WRITER);
    expect(row.writer.username).toBe('');
    expect(row.writer.name.displayName).toBe('Unknown user');
  });

  it('still renders the page when the whole identity batch fails', async () => {
    // The channel resolves (the gate needs it); the writers batch does not.
    resolveUserSummaries.mockImplementation(async (ids: string[]) => {
      if (ids.length === 1 && ids[0] === CHANNEL_ID) {
        return new Map([[CHANNEL_ID, { user: ACCOUNTS[CHANNEL_ID] }]]);
      }
      throw new Error('oxy is down');
    });

    const res = await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers`).expect(200);

    expect(res.body.data.writers.map((row: { writer: { username: string } }) => row.writer.username)).toEqual([
      '',
      '',
    ]);
  });

  /* --------------------------------------------------------------------- */
  /* Paging                                                                 */
  /* --------------------------------------------------------------------- */

  it('emits a cursor and resumes from it without skipping or repeating', async () => {
    const corpus = [
      post({ writtenByOxyUserId: WRITER_A, createdAt: at('2026-03-01T00:00:00.000Z') }),
      post({ writtenByOxyUserId: WRITER_B, createdAt: at('2026-02-01T00:00:00.000Z') }),
      post({ writtenByOxyUserId: WRITER_C, createdAt: at('2026-01-01T00:00:00.000Z') }),
    ];
    postAggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) =>
      runPipeline(corpus, pipeline),
    );
    const app = buildApp();

    const first = await request(app).get(`/channels/${CHANNEL_ID}/writers?limit=2`).expect(200);
    expect(first.body.data.writers.map((row: { writer: { id: string } }) => row.writer.id)).toEqual([
      WRITER_A,
      WRITER_B,
    ]);
    expect(typeof first.body.data.nextCursor).toBe('string');

    const second = await request(app)
      .get(`/channels/${CHANNEL_ID}/writers?limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor)}`)
      .expect(200);
    expect(second.body.data.writers.map((row: { writer: { id: string } }) => row.writer.id)).toEqual([
      WRITER_C,
    ]);
    expect(second.body.data.nextCursor).toBeUndefined();
  });

  /**
   * The tie-break the cursor exists for.
   *
   * Two writers whose most recent posts landed in the SAME millisecond straddle
   * the page boundary. On `lastPostAt` alone the second page's filter would drop
   * both or return both — the writer id in the keyset is what makes the boundary
   * exact.
   */
  it('does not lose a writer whose last post shares a millisecond with another', async () => {
    const sameInstant = at('2026-03-01T00:00:00.000Z');
    const corpus = [
      post({ writtenByOxyUserId: WRITER_A, createdAt: sameInstant }),
      post({ writtenByOxyUserId: WRITER_B, createdAt: sameInstant }),
      post({ writtenByOxyUserId: WRITER_C, createdAt: at('2026-01-01T00:00:00.000Z') }),
    ];
    postAggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) =>
      runPipeline(corpus, pipeline),
    );
    const app = buildApp();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const query = `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await request(app).get(`/channels/${CHANNEL_ID}/writers?${query}`).expect(200);
      seen.push(...res.body.data.writers.map((row: { writer: { id: string } }) => row.writer.id));
      cursor = res.body.data.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set([WRITER_A, WRITER_B, WRITER_C]));
  });

  it('treats a malformed cursor as the first page rather than an error', async () => {
    const res = await request(buildApp())
      .get(`/channels/${CHANNEL_ID}/writers?cursor=not-a-cursor`)
      .expect(200);

    expect(res.body.data.writers.map((row: { writer: { id: string } }) => row.writer.id)).toEqual([
      WRITER_A,
      WRITER_B,
    ]);
  });

  it('clamps the page size', async () => {
    await request(buildApp()).get(`/channels/${CHANNEL_ID}/writers?limit=99999`).expect(200);

    const pipeline = postAggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    const limitStage = pipeline.find((stage) => '$limit' in stage);
    // 100 is the cap; the route asks for one extra row to decide `nextCursor`.
    expect(limitStage).toEqual({ $limit: 101 });
  });
});
