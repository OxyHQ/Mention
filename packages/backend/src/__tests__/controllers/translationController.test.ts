import { OxyInferenceError } from '@oxyhq/core';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  loadPostRecord: vi.fn(),
  translatePost: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../db/posts/postRepository', () => ({
  loadPostRecord: mocks.loadPostRecord,
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: mocks.hydratePosts },
}));

vi.mock('../../services/PostTranslationService', () => {
  class TranslationRequestError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }

  return {
    postTranslationService: { translatePost: mocks.translatePost },
    TranslationRequestError,
  };
});

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  createUserScopedOxyServices: vi.fn(),
}));

vi.mock('../../utils/viewerLanguage', () => ({
  requestLanguageCandidates: vi.fn(() => ['es-ES']),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import { translatePost } from '../../controllers/posts/translation';

function response(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

function request(): OxyAuthRequest {
  return {
    params: { id: 'post-1' },
    body: { targetLanguage: 'es-ES' },
    user: { id: 'user-1' },
  } as unknown as OxyAuthRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPostRecord.mockResolvedValue({
    id: 'post-1',
    content: { text: 'Hallo' },
  });
  mocks.hydratePosts.mockResolvedValue([{ id: 'post-1' }]);
});

describe('post translation inference failures', () => {
  it('reports an upstream scope refusal as dependency unavailability, not a Mention 500', async () => {
    const error = new OxyInferenceError({
      code: 'insufficient_scope',
      message: 'This credential does not hold the inference:invoke scope.',
      retryable: false,
      requestId: 'oxy-request-1',
      status: 403,
    });
    mocks.translatePost.mockRejectedValue(error);
    const res = response();

    await translatePost(request(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Translation service temporarily unavailable.',
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      'translatePost: translation service unavailable',
      error,
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('preserves the explicit rate-limit response from the inference edge', async () => {
    mocks.translatePost.mockRejectedValue(new OxyInferenceError({
      code: 'rate_limited',
      message: 'Slow down.',
      retryable: true,
      requestId: 'oxy-request-2',
      retryAfterMs: 1_000,
      status: 429,
    }));
    const res = response();

    await translatePost(request(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Too many requests. Please try again later.',
    });
  });

  it('keeps unexpected local failures classified as Mention errors', async () => {
    mocks.translatePost.mockRejectedValue(new Error('database unavailable'));
    const res = response();

    await translatePost(request(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Translation failed' });
    expect(mocks.error).toHaveBeenCalledOnce();
  });
});
