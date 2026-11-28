/**
 * The edge purge itself: what it sends Cloudflare, how it batches, and that no
 * failure of it ever reaches the action that triggered it.
 *
 * The queue, the origin caches and the HTTP call are the seams. Which writes
 * trigger a purge is `postPageEdgePurgeTriggers.test.ts`, against real rows.
 */
import { UnrecoverableError, type Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  invalidatePostDetails: vi.fn(),
  invalidatePostOgCards: vi.fn(),
  incrementCounter: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  runAuthorPostPagePurge: vi.fn(),
  dependents: vi.fn(),
  token: 'test-purge-token' as string | undefined,
}));

vi.mock('../../queue/producers', () => ({ enqueuePostPageEdgePurge: mocks.enqueue }));
vi.mock('../../services/posts/postDetailCache', () => ({
  invalidateMany: mocks.invalidatePostDetails,
}));
vi.mock('../../services/webshell/webShellOgCache', () => ({
  invalidatePostOgCards: mocks.invalidatePostOgCards,
}));
vi.mock('../../services/webshell/postPageDependents', () => ({
  findDependentPostIds: mocks.dependents,
}));
vi.mock('../../services/webshell/authorPostPagePurge', () => ({
  runAuthorPostPagePurge: mocks.runAuthorPostPagePurge,
}));
vi.mock('../../utils/metrics', () => ({ metrics: { incrementCounter: mocks.incrementCounter } }));
vi.mock('../../utils/logger', () => ({
  logger: { error: mocks.error, warn: mocks.warn, info: mocks.info, debug: vi.fn() },
}));
vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      web: { ...actual.config.web, origin: 'https://mention.earth' },
      edgePurge: { enabled: true, zoneId: '6c2a616f72102ee543329c87fa3b5e08' },
    },
    getCloudflarePurgeToken: () => mocks.token,
  };
});

import { config } from '../../config';
import {
  POST_PAGE_PURGE_FAILED_METRIC,
  POST_PAGE_PURGE_GAVE_UP_LOG,
  POST_PAGE_PURGE_QUEUE_DEADLINE_MS,
  postPageUrls,
  purgePostPages,
  runPostPagePurge,
  scheduleAuthorPostPagePurge,
} from '../../services/webshell/postPageEdgePurge';
import { processPostPageEdgePurgeJob } from '../../services/webshell/postPageEdgePurgeJob';
import {
  CloudflarePurgeRejectedError,
  CloudflarePurgeRetryableError,
  purgeCloudflareUrls,
} from '../../services/webshell/cloudflarePurgeClient';
import {
  POST_PAGE_EDGE_PURGE_PRIORITY_ACTION,
  POST_PAGE_EDGE_PURGE_PRIORITY_SWEEP,
} from '../../queue/constants';
import type { PostPageEdgePurgeJobData } from '../../queue/types';

const fetchMock = vi.fn();

function cloudflareAnswers(status: number, body: unknown): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function setEnabled(enabled: boolean): void {
  (config.edgePurge as { enabled: boolean }).enabled = enabled;
}

function job(
  data: PostPageEdgePurgeJobData,
  attemptsMade: number,
  attempts = 8,
): Job<PostPageEdgePurgeJobData> {
  return { data, attemptsMade, opts: { attempts } } as unknown as Job<PostPageEdgePurgeJobData>;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `post-${i}`);

beforeEach(() => {
  vi.clearAllMocks();
  setEnabled(true);
  mocks.token = 'test-purge-token';
  mocks.enqueue.mockResolvedValue(true);
  mocks.invalidatePostDetails.mockResolvedValue(undefined);
  mocks.invalidatePostOgCards.mockResolvedValue(undefined);
  mocks.dependents.mockResolvedValue([]);
  vi.stubGlobal('fetch', fetchMock);
  cloudflareAnswers(200, { success: true, errors: [], result: { id: 'zone' } });
});

describe('the give-up line', () => {
  it('is the exact string the CloudWatch alarm matches', () => {
    // A CROSS-REPO CONTRACT: oxy-infra terraform-uswest2/alerts.tf
    // (`mention_post_page_edge_purge_failed`) filters /oxy/ecs on this literal,
    // and tests/test_mention_post_page_edge_purge_alarm.py pins that side.
    // Changing it here without there silently disarms the alarm.
    expect(POST_PAGE_PURGE_GAVE_UP_LOG).toBe('[EdgePurge] post page purge gave up');
  });
});

describe('postPageUrls', () => {
  it('names the page with and without the trailing slash the route accepts', () => {
    expect(postPageUrls('019fd158-c7ff-7ae3-8edb-a8b2589800f2')).toEqual([
      'https://mention.earth/p/019fd158-c7ff-7ae3-8edb-a8b2589800f2',
      'https://mention.earth/p/019fd158-c7ff-7ae3-8edb-a8b2589800f2/',
    ]);
  });

  it('encodes an id, so a stray character cannot name another path', () => {
    expect(postPageUrls('a/b?c')[0]).toBe('https://mention.earth/p/a%2Fb%3Fc');
  });
});

describe('purgePostPages', () => {
  it('evicts the origin caches first, then queues one job per 15 posts (30 URLs)', async () => {
    await purgePostPages([...ids(31), 'post-0', ''], 'delete');

    expect(mocks.invalidatePostDetails).toHaveBeenCalledWith(ids(31));
    expect(mocks.invalidatePostOgCards).toHaveBeenCalledWith(ids(31));
    expect(mocks.enqueue).toHaveBeenCalledTimes(3);
    const batches = mocks.enqueue.mock.calls.map(([data]) => data.postIds.length);
    expect(batches).toEqual([15, 15, 1]);
    expect(mocks.enqueue.mock.calls[0]).toEqual([
      { kind: 'posts', postIds: ids(15), reason: 'delete' },
      { priority: POST_PAGE_EDGE_PURGE_PRIORITY_ACTION, delayMs: expect.any(Number) },
    ]);
    expect(mocks.invalidatePostDetails.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueue.mock.invocationCallOrder[0],
    );
  });

  it('queues a sweep behind a person’s own actions', async () => {
    await purgePostPages(['a'], 'author_erased', { priority: 'sweep' });
    expect(mocks.enqueue.mock.calls[0][1].priority).toBe(POST_PAGE_EDGE_PURGE_PRIORITY_SWEEP);
  });

  it('does nothing at all when purging is off', async () => {
    setEnabled(false);
    await purgePostPages(['a'], 'delete');
    await scheduleAuthorPostPagePurge('user-1', 'oxy|1');

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.invalidatePostDetails).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves when the queue refuses the job, and logs the line the alarm watches', async () => {
    mocks.enqueue.mockRejectedValue(new Error('Redis connection lost'));

    await expect(purgePostPages(['a', 'b'], 'edit')).resolves.toBeUndefined();

    expect(mocks.error).toHaveBeenCalledWith(
      POST_PAGE_PURGE_GAVE_UP_LOG,
      expect.objectContaining({ reason: 'edit', stage: 'enqueue', posts: 2 }),
    );
    expect(mocks.incrementCounter).toHaveBeenCalledWith(POST_PAGE_PURGE_FAILED_METRIC, 1, {
      reason: 'edit',
      stage: 'enqueue',
    });
  });

  it('resolves when the origin caches cannot be evicted, and still queues the purge', async () => {
    mocks.invalidatePostDetails.mockRejectedValue(new Error('Redis down'));

    await expect(purgePostPages(['a'], 'moderation')).resolves.toBeUndefined();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('also evicts and queues the pages that repeat the posts', async () => {
    mocks.dependents.mockResolvedValue(['boost', 'parent']);

    await purgePostPages(['a'], 'edit');

    expect(mocks.dependents).toHaveBeenCalledWith(['a']);
    expect(mocks.invalidatePostOgCards).toHaveBeenCalledWith(['boost', 'parent']);
    expect(mocks.enqueue.mock.calls.map(([data]) => data.postIds)).toEqual([
      ['a'],
      ['boost', 'parent'],
    ]);
  });

  it('still queues the posts’ own pages when their dependents cannot be read', async () => {
    mocks.dependents.mockRejectedValue(new Error('database gone'));

    await expect(purgePostPages(['a'], 'edit')).resolves.toBeUndefined();

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      POST_PAGE_PURGE_GAVE_UP_LOG,
      expect.objectContaining({ reason: 'edit', stage: 'enqueue' }),
    );
  });

  it.each([
    ['a post purge', () => purgePostPages(['a'], 'delete'), 'delete'],
    ['an author sweep', () => scheduleAuthorPostPagePurge('user-1'), 'author_check'],
  ])('stops holding %s when the enqueue never settles', async (_label, call, reason) => {
    vi.useFakeTimers();
    try {
      mocks.enqueue.mockReturnValue(new Promise(() => {}));
      let resolved = false;
      const pending = call().then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(POST_PAGE_PURGE_QUEUE_DEADLINE_MS - 1);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(mocks.error).toHaveBeenCalledWith(
        POST_PAGE_PURGE_GAVE_UP_LOG,
        expect.objectContaining({ reason, stage: 'enqueue' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a queue, tries once inline and never rejects, even when Cloudflare fails', async () => {
    mocks.enqueue.mockResolvedValue(false);
    cloudflareAnswers(503, { success: false, errors: [{ code: 10000, message: 'unavailable' }] });

    await expect(purgePostPages(['a'], 'delete')).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        POST_PAGE_PURGE_GAVE_UP_LOG,
        expect.objectContaining({ stage: 'inline', reason: 'delete' }),
      ),
    );
  });
});

describe('scheduleAuthorPostPagePurge', () => {
  it('queues one author check, keyed by the trigger so every task’s copy is one job', async () => {
    await scheduleAuthorPostPagePurge('user-1', 'oxy|42');

    expect(mocks.enqueue).toHaveBeenCalledWith(
      { kind: 'author', oxyUserId: 'user-1' },
      expect.objectContaining({ dedupeKey: 'author|user-1|oxy|42' }),
    );
  });

  it('resolves when the queue refuses it', async () => {
    mocks.enqueue.mockRejectedValue(new Error('Redis connection lost'));
    await expect(scheduleAuthorPostPagePurge('user-1')).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith(
      POST_PAGE_PURGE_GAVE_UP_LOG,
      expect.objectContaining({ reason: 'author_check' }),
    );
  });
});

describe('runPostPagePurge (the worker half)', () => {
  it('evicts the origin caches again, then purges both URLs of every post in one call', async () => {
    await runPostPagePurge(['a', 'b'], 'delete');

    expect(mocks.invalidatePostDetails).toHaveBeenCalledWith(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/zones/6c2a616f72102ee543329c87fa3b5e08/purge_cache',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-purge-token');
    expect(JSON.parse(init.body)).toEqual({
      files: [
        'https://mention.earth/p/a',
        'https://mention.earth/p/a/',
        'https://mention.earth/p/b',
        'https://mention.earth/p/b/',
      ],
    });
  });

  it('drops a job queued before purging was switched off', async () => {
    mocks.token = undefined;
    await runPostPagePurge(['a'], 'delete');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('processPostPageEdgePurgeJob', () => {
  const data: PostPageEdgePurgeJobData = { kind: 'posts', postIds: ['a'], reason: 'delete' };

  it('rethrows a transient failure for BullMQ to retry, without raising the alarm', async () => {
    cloudflareAnswers(429, { success: false, errors: [{ code: 971, message: 'throttled' }] });

    await expect(processPostPageEdgePurgeJob(job(data, 0))).rejects.toBeInstanceOf(
      CloudflarePurgeRetryableError,
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('raises the alarm on the last attempt', async () => {
    cloudflareAnswers(500, { success: false, errors: [] });

    await expect(processPostPageEdgePurgeJob(job(data, 7))).rejects.toBeInstanceOf(
      CloudflarePurgeRetryableError,
    );
    expect(mocks.error).toHaveBeenCalledWith(
      POST_PAGE_PURGE_GAVE_UP_LOG,
      expect.objectContaining({ reason: 'delete', stage: 'purge', posts: 1 }),
    );
  });

  it('gives up at once, and says so, when Cloudflare refuses the token', async () => {
    cloudflareAnswers(403, {
      success: false,
      errors: [{ code: 10000, message: 'Authentication error' }],
    });

    await expect(processPostPageEdgePurgeJob(job(data, 0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(mocks.error).toHaveBeenCalledWith(
      POST_PAGE_PURGE_GAVE_UP_LOG,
      expect.objectContaining({ error: expect.stringContaining('403') }),
    );
    // The token never reaches a log line.
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('test-purge-token');
  });

  it('runs an author job through the sweep', async () => {
    mocks.runAuthorPostPagePurge.mockResolvedValue({ swept: 3 });
    await processPostPageEdgePurgeJob(job({ kind: 'author', oxyUserId: 'user-1' }, 0));
    expect(mocks.runAuthorPostPagePurge).toHaveBeenCalledWith('user-1');
  });
});

describe('purgeCloudflareUrls', () => {
  const target = { zoneId: 'zone', token: 't', fetchImpl: fetchMock as unknown as typeof fetch };

  it('refuses more than 30 URLs rather than sending a call Cloudflare rejects', async () => {
    const urls = Array.from({ length: 31 }, (_, i) => `https://mention.earth/p/${i}`);
    await expect(purgeCloudflareUrls(urls, target)).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a refused connection as retryable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(purgeCloudflareUrls(['u'], target)).rejects.toBeInstanceOf(
      CloudflarePurgeRetryableError,
    );
  });

  it('treats a 400 as permanent', async () => {
    cloudflareAnswers(400, { success: false, errors: [{ code: 1012, message: 'bad url' }] });
    await expect(purgeCloudflareUrls(['u'], target)).rejects.toBeInstanceOf(
      CloudflarePurgeRejectedError,
    );
  });

  it('sends nothing for no URLs', async () => {
    await purgeCloudflareUrls([], target);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
