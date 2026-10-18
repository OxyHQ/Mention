import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: {
    inference: { timeoutMs: 1_000 },
  },
  credentials: {
    apiKey: 'application-id' as string | undefined,
    apiSecret: 'application-secret' as string | undefined,
  },
  create: vi.fn(),
  credential: undefined as undefined | (() => Promise<string>),
  serviceTokenFor: vi.fn(async (_audience: string) => 'service-token'),
  logError: vi.fn(),
}));

vi.mock('../../config', () => ({
  config: state.config,
  getOxyServiceCredentials: () => state.credentials,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ serviceTokenFor: state.serviceTokenFor }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: state.logError },
}));

vi.mock('@kaana.ai/sdk', () => ({
  Kaana: class {
    responses = { create: state.create };
    constructor(options: { credential: () => Promise<string> }) {
      state.credential = options.credential;
    }
  },
}));

import {
  clearInferenceClient,
  inferenceChat,
  inferenceJSON,
  isInferenceEnabled,
} from '../../utils/inference';

describe('Kaana inference boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearInferenceClient();
    state.credentials.apiKey = 'application-id';
    state.credentials.apiSecret = 'application-secret';
    state.create.mockResolvedValue({
      output: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }],
    });
  });

  it('asks for the instant power level with product labels, delegating the end user', async () => {
    await expect(
      inferenceChat(
        [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello' },
        ],
        {
          feature: 'test-feature',
          delegatedUserId: 'user-123',
          temperature: 0.2,
          maxTokens: 128,
        },
      ),
    ).resolves.toBe('answer');

    expect(state.create).toHaveBeenCalledOnce();
    const [request, options] = state.create.mock.calls[0];
    expect(request).toEqual({
      model: 'instant',
      input: [
        { role: 'system', content: [{ type: 'text', text: 'Be concise.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
      labels: { product: 'mention', feature: 'test-feature' },
      temperature: 0.2,
      maxOutputTokens: 128,
    });
    expect(options).toEqual({ timeoutMs: 1_000, onBehalfOfUserId: 'user-123' });
    await expect(state.credential?.()).resolves.toBe('service-token');
    expect(state.serviceTokenFor).toHaveBeenCalledWith('kaana.ai');
  });

  it('fails closed without a service identity', async () => {
    state.credentials.apiKey = undefined;
    state.credentials.apiSecret = undefined;
    expect(isInferenceEnabled()).toBe(false);
    await expect(
      inferenceChat([{ role: 'user', content: 'Hello' }], { feature: 'test-feature' }),
    ).rejects.toThrow('service identity');
    expect(state.create).not.toHaveBeenCalled();
  });

  it('unwraps fenced JSON without weakening parse failures', async () => {
    state.create.mockResolvedValueOnce({
      output: [
        { role: 'assistant', content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }] },
      ],
    });
    await expect(
      inferenceJSON<{ ok: boolean }>([{ role: 'user', content: 'Return JSON' }], {
        feature: 'test-json',
      }),
    ).resolves.toEqual({ ok: true });

    const sensitiveOutput = 'private-user-content-that-must-not-leak';
    state.create.mockResolvedValueOnce({
      output: [{ role: 'assistant', content: [{ type: 'text', text: sensitiveOutput }] }],
    });
    await expect(
      inferenceJSON([{ role: 'user', content: 'Return JSON' }], { feature: 'test-json' }),
    ).rejects.toThrow('invalid JSON');
    expect(state.logError).toHaveBeenCalledWith('[Inference] Failed to parse JSON response:', {
      status: 'rejected',
      code: 'invalid_json',
      responseBytes: Buffer.byteLength(sensitiveOutput, 'utf8'),
    });
    expect(JSON.stringify(state.logError.mock.calls)).not.toContain(sensitiveOutput);
  });
});
