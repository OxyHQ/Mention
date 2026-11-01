import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { getDb, isDbAvailable } from '../database';
import { appendFeedItems, getAllFeedItems, setFeedItems } from '../feedQueries';
import { runMigrations } from '../migrations';
import { upsertPosts } from '../postQueries';
import { memClearAll } from '../memoryStore';
import type { FeedItem } from '../schema';

jest.mock('../database', () => ({ getDb: jest.fn(), isDbAvailable: jest.fn() }));

function makeDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const prepared: Array<{
    sql: string;
    executeSync: jest.Mock;
    finalizeSync: jest.Mock;
  }> = [];
  let beforePrepare: ((sql: string) => void) | undefined;
  let beforeExecute: ((sql: string, params: SQLInputValue[]) => void) | undefined;
  const db = {
    execSync: (sql: string) => sqlite.exec(sql),
    getFirstSync: (sql: string, ...params: SQLInputValue[]) => sqlite.prepare(sql).get(...params),
    getAllSync: (sql: string, ...params: SQLInputValue[]) => sqlite.prepare(sql).all(...params),
    runSync: (sql: string, ...params: SQLInputValue[]) => sqlite.prepare(sql).run(...params),
    prepareSync: jest.fn((sql: string) => {
      beforePrepare?.(sql);
      const statement = sqlite.prepare(sql);
      const entry = {
        sql,
        executeSync: jest.fn((...params: SQLInputValue[]) => {
          beforeExecute?.(sql, params);
          return statement.run(...params);
        }),
        finalizeSync: jest.fn(),
      };
      prepared.push(entry);
      return entry;
    }),
  };
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
  return {
    db,
    prepared,
    sqlite,
    failPrepare: (fn: typeof beforePrepare) => {
      beforePrepare = fn;
    },
    failExecute: (fn: typeof beforeExecute) => {
      beforeExecute = fn;
    },
  };
}

const post = (id: string): FeedItem =>
  ({
    id,
    user: { id: 'user-1', username: 'alice', name: { displayName: 'Alice' } },
    authors: [],
    content: { text: `post ${id}` },
    attachments: {},
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
    permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
    viewerState: {
      isOwner: false,
      isCollaborator: false,
      isLiked: false,
      isDownvoted: false,
      isBoosted: false,
      isSaved: false,
    },
    metadata: {
      visibility: 'public',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  }) as FeedItem;
const metadata = { hasMore: true, totalCount: 3, lastUpdated: 1 };
const feedSql = 'INSERT OR IGNORE INTO feed_items';
const postSql = 'INSERT INTO posts';

describe('SQLite feed batch writes', () => {
  let testDb: ReturnType<typeof makeDatabase>;
  beforeEach(() => {
    jest.clearAllMocks();
    testDb = makeDatabase();
    (isDbAvailable as jest.Mock).mockReturnValue(true);
    (getDb as jest.Mock).mockReturnValue(testDb.db);
  });
  afterEach(() => testDb.sqlite.close());

  it('reuses and finalizes one statement per batch, preserving duplicate and feed order', () => {
    const updatedA = { ...post('a'), content: { text: 'newer copy' } };
    setFeedItems('home', [post('a'), updatedA, post('b')], metadata);
    const appended = appendFeedItems('home', [post('b'), post('c'), post('c'), post('d')], {});
    expect(appended?.map((item) => item.id)).toEqual(['c', 'd']);
    const rows = getAllFeedItems('home');
    expect(rows.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows[0].content.text).toBe('newer copy');
    const postWrites = testDb.prepared.filter(({ sql }) => sql.includes(postSql));
    const feedWrites = testDb.prepared.filter(({ sql }) => sql.includes(feedSql));
    expect(postWrites).toHaveLength(2);
    expect(feedWrites).toHaveLength(2);
    expect(postWrites.map((entry) => entry.executeSync.mock.calls.length)).toEqual([3, 4]);
    expect(feedWrites.map((entry) => entry.executeSync.mock.calls.length)).toEqual([3, 4]);
    for (const entry of [...postWrites, ...feedWrites])
      expect(entry.finalizeSync).toHaveBeenCalledTimes(1);
  });

  it('rolls back post writes and finalizes when execution fails', () => {
    testDb.failExecute((sql, params) => {
      if (sql.includes(postSql) && params[0] === 'b') throw new Error('post write failed');
    });
    expect(() => upsertPosts([post('a'), post('b')])).toThrow('post write failed');
    expect(testDb.sqlite.prepare('SELECT id FROM posts').all()).toEqual([]);
    expect(
      testDb.prepared.find(({ sql }) => sql.includes(postSql))?.finalizeSync,
    ).toHaveBeenCalledTimes(1);
  });

  it('rolls back a replaced feed and finalizes when an insertion fails', () => {
    setFeedItems('home', [post('old')], metadata);
    testDb.failExecute((sql, params) => {
      if (sql.includes(feedSql) && params[1] === 'b') throw new Error('feed write failed');
    });
    setFeedItems('home', [post('a'), post('b')], metadata);
    expect(getAllFeedItems('home').map((item) => item.id)).toEqual(['old']);
    const writes = testDb.prepared.filter(({ sql }) => sql.includes(feedSql));
    expect(writes).toHaveLength(2);
    for (const write of writes) expect(write.finalizeSync).toHaveBeenCalledTimes(1);
  });

  it('rolls back when statement preparation fails', () => {
    setFeedItems('home', [post('old')], metadata);
    testDb.failPrepare((sql) => {
      if (sql.includes(feedSql)) throw new Error('prepare failed');
    });
    setFeedItems('home', [post('new')], metadata);
    expect(getAllFeedItems('home').map((item) => item.id)).toEqual(['old']);
    expect(testDb.db.execSync('BEGIN TRANSACTION')).toBeUndefined();
    testDb.db.execSync('ROLLBACK');
  });

  it('rolls back the post transaction when preparation fails', () => {
    testDb.failPrepare((sql) => {
      if (sql.includes(postSql)) throw new Error('post prepare failed');
    });
    expect(() => upsertPosts([post('a')])).toThrow('post prepare failed');
    expect(testDb.sqlite.prepare('SELECT id FROM posts').all()).toEqual([]);
    expect(testDb.db.execSync('BEGIN TRANSACTION')).toBeUndefined();
    testDb.db.execSync('ROLLBACK');
  });

  it('rolls back the entire append when an insertion fails', () => {
    setFeedItems('home', [post('old')], metadata);
    testDb.failExecute((sql, params) => {
      if (sql.includes(feedSql) && params[1] === 'b') throw new Error('append failed');
    });
    expect(appendFeedItems('home', [post('a'), post('b')], {})).toBeNull();
    expect(getAllFeedItems('home').map((item) => item.id)).toEqual(['old']);
    const writes = testDb.prepared.filter(({ sql }) => sql.includes(feedSql));
    expect(writes).toHaveLength(2);
    expect(writes[1].finalizeSync).toHaveBeenCalledTimes(1);
  });

  it('does not prepare an insert for empty batches or posts without IDs', () => {
    setFeedItems('home', [post('old')], metadata);
    testDb.prepared.length = 0;
    testDb.failPrepare((sql) => {
      if (sql.includes(postSql) || sql.includes(feedSql)) throw new Error('unexpected prepare');
    });
    upsertPosts([]);
    upsertPosts([post('')]);
    expect(appendFeedItems('home', [], {})).toEqual([]);
    expect(appendFeedItems('home', [post('')], {})).toEqual([]);
    setFeedItems('home', [], metadata);
    expect(getAllFeedItems('home')).toEqual([]);
    setFeedItems('home', [post('')], metadata);
    expect(getAllFeedItems('home')).toEqual([]);
    expect(testDb.prepared).toEqual([]);
  });

  it('keeps the memory path independent of SQLite statements', () => {
    memClearAll();
    (isDbAvailable as jest.Mock).mockReturnValue(false);
    setFeedItems('home', [post('a'), post('b')], metadata);
    expect(appendFeedItems('home', [post('b'), post('c')], {})?.map((item) => item.id)).toEqual([
      'c',
    ]);
    expect(getAllFeedItems('home').map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(testDb.db.prepareSync).not.toHaveBeenCalled();
    memClearAll();
  });
});
