import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const { findOne, resolveUserSummaries } = vi.hoisted(() => ({
  findOne: vi.fn(),
  resolveUserSummaries: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  Post: { findOne },
}));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries,
  isFallbackUserSummary: (user: { username?: string }) => !user.username,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { getPostEditSource } from '../../controllers/postEditSource.controller';

const POST_ID = '507f1f77bcf86cd799439011';

function responseDouble() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

function request(userId?: string): OxyAuthRequest {
  return {
    params: { id: POST_ID },
    user: userId ? { id: userId } : undefined,
  } as unknown as OxyAuthRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPostEditSource', () => {
  it('requires an authenticated owner', async () => {
    const res = responseDouble();
    await getPostEditSource(request(), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('returns raw author bodies and drops orphan mention ids', async () => {
    const doc = {
      _id: POST_ID,
      content: {
        variants: [
          {
            source: 'author',
            tag: 'en',
            text: 'Hello [mention:alice-id]',
          },
          {
            source: 'author',
            tag: 'es',
            text: 'Hola [mention:bob-id]',
          },
          {
            source: 'machine',
            tag: 'it',
            text: 'Ciao [mention:machine-id]',
          },
        ],
        media: [{ id: 'media-1', type: 'image' }],
      },
      mentions: ['orphan-id', 'bob-id', 'alice-id', 'machine-id'],
      authorship: [{ oxyUserId: 'owner', role: 'owner', status: 'accepted' }],
      parentPostId: null,
    };
    findOne.mockReturnValue({
      select: () => ({ lean: async () => doc }),
    });
    resolveUserSummaries.mockResolvedValue(
      new Map([
        [
          'alice-id',
          {
            user: {
              id: 'alice-id',
              username: 'alice',
              name: { displayName: 'Alice' },
            },
          },
        ],
        [
          'bob-id',
          {
            user: {
              id: 'bob-id',
              username: '',
              name: { displayName: 'Unknown user' },
            },
          },
        ],
      ]),
    );

    const res = responseDouble();
    await getPostEditSource(request('owner'), res as unknown as Response);

    expect(findOne).toHaveBeenCalledWith({ _id: POST_ID, oxyUserId: 'owner' });
    expect(res.json).toHaveBeenCalledWith({
      id: POST_ID,
      content: {
        text: 'Hello [mention:alice-id]',
        variants: [
          {
            source: 'author',
            tag: 'en',
            text: 'Hello [mention:alice-id]',
          },
          {
            source: 'author',
            tag: 'es',
            text: 'Hola [mention:bob-id]',
          },
        ],
        media: [{ id: 'media-1', type: 'image' }],
      },
      mentions: ['alice-id', 'bob-id'],
      mentionUsers: [
        {
          id: 'alice-id',
          username: 'alice',
          name: { displayName: 'Alice' },
        },
      ],
      authorship: [{ oxyUserId: 'owner', role: 'owner', status: 'accepted' }],
    });
  });

  it("does not reveal another owner's draft", async () => {
    const ownerDraft = {
      _id: POST_ID,
      status: 'draft',
      oxyUserId: 'owner',
      content: { text: 'private draft [mention:alice-id]' },
      mentions: ['alice-id'],
    };
    findOne.mockImplementation((filter: Record<string, unknown>) => ({
      select: () => ({
        // Model the security boundary: an unscoped lookup would find the draft,
        // while the viewer-scoped lookup must not.
        lean: async () =>
          filter.oxyUserId === 'viewer' ? null : ownerDraft,
      }),
    }));
    const res = responseDouble();
    await getPostEditSource(request('viewer'), res as unknown as Response);

    expect(findOne).toHaveBeenCalledWith({
      _id: POST_ID,
      oxyUserId: 'viewer',
    });
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
