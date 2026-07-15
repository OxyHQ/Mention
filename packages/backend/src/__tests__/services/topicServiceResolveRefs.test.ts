import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopicType } from '@oxyhq/core';

/**
 * Unit coverage for {@link TopicService.resolveTopicRefs} — the single place that
 * links canonical topic slugs into the Topic registry (`topicId`). It must:
 *   - carry `topicId` for names that resolve to a Topic document;
 *   - return a `name`-only ref for names that DON'T resolve;
 *   - preserve input order 1:1 and pass through optional relevance/type;
 *   - degrade to all-name-only refs (never drop the list) when the registry call
 *     throws.
 *
 * The Oxy service client (which `resolveNames` proxies to) is mocked — no network.
 */

const mocks = vi.hoisted(() => ({
  resolveTopicNames: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ resolveTopicNames: mocks.resolveTopicNames }),
}));
// TopicStats / alia are imported by the module; stub so it loads purely.
vi.mock('../../models/TopicStats', () => ({ __esModule: true, default: { bulkWrite: vi.fn(), find: vi.fn() } }));
vi.mock('../../utils/alia', () => ({ aliaJSON: vi.fn(), isAliaEnabled: () => false }));

import { topicService } from '../../services/TopicService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TopicService.resolveTopicRefs', () => {
  it('attaches the resolved topicId and preserves order, passing through relevance/type', async () => {
    mocks.resolveTopicNames.mockResolvedValue([
      { _id: 'id-basketball', name: 'basketball' },
      { _id: 'id-lakers', name: 'lakers' },
    ]);

    const refs = await topicService.resolveTopicRefs([
      { name: 'basketball', relevance: 9, type: 'topic' },
      { name: 'lakers', type: 'entity' },
    ]);

    expect(refs).toEqual([
      { name: 'basketball', topicId: 'id-basketball', relevance: 9, type: 'topic' },
      { name: 'lakers', topicId: 'id-lakers', type: 'entity' },
    ]);
    // Names resolve with the right registry types (entity vs topic default).
    expect(mocks.resolveTopicNames).toHaveBeenCalledWith([
      { name: 'basketball', type: TopicType.TOPIC },
      { name: 'lakers', type: TopicType.ENTITY },
    ]);
  });

  it('returns a name-only ref for a name that does not resolve to a Topic document', async () => {
    mocks.resolveTopicNames.mockResolvedValue([{ _id: 'id-known', name: 'known' }]);

    const refs = await topicService.resolveTopicRefs([
      { name: 'known' },
      { name: 'unknown' },
    ]);

    expect(refs).toEqual([
      { name: 'known', topicId: 'id-known' },
      { name: 'unknown' },
    ]);
  });

  it('degrades to all name-only refs when the registry call throws (never drops the list)', async () => {
    mocks.resolveTopicNames.mockRejectedValue(new Error('oxy unreachable'));

    const refs = await topicService.resolveTopicRefs([
      { name: 'coffee', relevance: 7 },
      { name: 'espresso' },
    ]);

    // resolveNames swallows the error and returns an empty map → no topicIds, but
    // the names (and any relevance) are preserved.
    expect(refs).toEqual([
      { name: 'coffee', relevance: 7 },
      { name: 'espresso' },
    ]);
  });

  it('returns [] for an empty input (no registry call)', async () => {
    const refs = await topicService.resolveTopicRefs([]);
    expect(refs).toEqual([]);
    expect(mocks.resolveTopicNames).not.toHaveBeenCalled();
  });
});
