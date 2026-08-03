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

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: vi.fn(() => undefined),
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
      // A real row always names its author, and the handler now authorizes on
      // it rather than on the query filter.
      oxyUserId: 'owner',
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

    // Looked up by id; who may read it is decided afterwards by
    // `postManagementRefusal`, because a channel post's `oxyUserId` is the
    // channel and an owner-scoped query could never find one.
    expect(findOne).toHaveBeenCalledWith({ _id: POST_ID });
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
    // The lookup now FINDS the draft — the boundary moved from the query to the
    // authorization, so this fixture is the one that actually exercises it. A
    // scoped query answering null would pass whether the check existed or not.
    findOne.mockReturnValue({ select: () => ({ lean: async () => ownerDraft }) });
    const res = responseDouble();
    await getPostEditSource(request('viewer'), res as unknown as Response);

    expect(findOne).toHaveBeenCalledWith({ _id: POST_ID });
    expect(res.status).toHaveBeenCalledWith(404);
    // Nothing of the draft may reach the caller — not its body, not its
    // existence beyond the same 404 a missing post answers.
    expect(res.json).toHaveBeenCalledWith({ message: 'Post not found' });
  });

  it("lets a CHANNEL post's writer open it, though the channel is the author", async () => {
    // The defect this route shares with `updatePost`: a channel post is
    // authored by an account nobody can sign in as, so an owner-scoped lookup
    // refused the composer to the very person who wrote it.
    findOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: POST_ID,
          status: 'published',
          oxyUserId: 'oxy-channel-account',
          writtenByOxyUserId: 'writer',
          content: { text: 'from the channel' },
          mentions: [],
        }),
      }),
    });
    resolveUserSummaries.mockResolvedValue(new Map());
    const res = responseDouble();

    await getPostEditSource(request('writer'), res as unknown as Response);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: POST_ID, content: expect.objectContaining({ text: 'from the channel' }) }),
    );
  });
});
