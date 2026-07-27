import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MENTION_NODE_PUBLIC_COLLECTIONS,
} from '../../../services/mtn/mentionNodes.constants';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
}));

vi.mock('../../../models/MentionSignedRecord', () => ({
  MTN_CANONICAL_RECORD_FILTER: {
    chainStatus: { $ne: 'conflict' },
  },
  default: {
    find: (...args: unknown[]) => mocks.find(...args),
  },
}));

vi.mock('../../../services/mtn/MentionRecordStore', () => ({
  mentionRecordStore: {
    getHead: vi.fn(),
  },
}));

import { getPublicLogSince } from '../../../services/mtn/MentionRepoLogService';

describe('MentionRepoLogService branch selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports canonical and legacy rows but excludes conflict archives', async () => {
    const query = {
      sort: vi.fn(),
      limit: vi.fn(),
      lean: vi.fn(async () => []),
    };
    query.sort.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    mocks.find.mockReturnValue(query);

    await expect(getPublicLogSince('actor-1', 2, 25)).resolves.toEqual([]);

    expect(mocks.find).toHaveBeenCalledWith({
      oxyUserId: 'actor-1',
      seq: { $gt: 2 },
      nsid: { $in: MENTION_NODE_PUBLIC_COLLECTIONS },
      chainStatus: { $ne: 'conflict' },
    });
  });
});
