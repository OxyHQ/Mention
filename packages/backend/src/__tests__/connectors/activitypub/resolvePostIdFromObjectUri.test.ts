import { describe, it, expect, vi, beforeEach } from 'vitest';

const { postFindOne } = vi.hoisted(() => ({
  postFindOne: vi.fn(),
}));

function chainable(row: unknown | null) {
  return { lean: async () => row };
}

vi.mock('mongoose', () => ({
  default: { Types: { ObjectId: { isValid: () => false } } },
  Types: { ObjectId: { isValid: () => false } },
}));

vi.mock('../../../models/Post', () => ({
  Post: {
    findOne: (...args: unknown[]) => chainable(postFindOne(...args)),
  },
}));

import { resolvePostIdFromObjectUri } from '../../../connectors/activitypub/helpers';

describe('resolvePostIdFromObjectUri', () => {
  beforeEach(() => {
    postFindOne.mockReset();
  });

  it('only resolves imported federated quote targets when they are published and public', async () => {
    const objectUri = 'https://remote.example/users/alice/statuses/private-note';
    postFindOne.mockResolvedValue(null);

    await expect(resolvePostIdFromObjectUri(objectUri)).resolves.toBeNull();

    expect(postFindOne).toHaveBeenCalledWith(
      {
        'federation.activityId': objectUri,
        status: 'published',
        visibility: 'public',
      },
      { _id: 1 },
    );
  });
});
