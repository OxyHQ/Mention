import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: {
    oxyApiUrl: 'https://api.oxy.test',
    inference: {
      routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd' as string | undefined,
      timeoutMs: 1_000,
    },
  },
  credentials: {
    apiKey: 'application-id' as string | undefined,
    apiSecret: 'application-secret' as string | undefined,
  },
  respond: vi.fn(),
  getServiceToken: vi.fn(async () => 'service-token'),
}));

vi.mock('../../config', () => ({
  config: state.config,
  getOxyServiceCredentials: () => state.credentials,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getServiceToken: state.getServiceToken }),
}));

vi.mock('@oxyhq/core', () => ({
  OxyInferenceClient: class {
    respond = state.respond;
  },
}));

import {
  clearInferenceClient,
  inferenceChat,
  inferenceJSON,
  isInferenceEnabled,
} from '../../utils/oxyInference';

describe('Oxy inference boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearInferenceClient();
    state.config.inference.routingProfileId = '01a06477-94f5-74f0-bc25-4c5c13b93ccd';
    state.credentials.apiKey = 'application-id';
    state.credentials.apiSecret = 'application-secret';
    state.respond.mockResolvedValue({
      output: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }],
    });
  });

  it('submits only the exact routing profile ID and product labels, delegating the end user', async () => {
    await expect(inferenceChat(
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
    )).resolves.toBe('answer');

    expect(state.respond).toHaveBeenCalledOnce();
    const [request, options] = state.respond.mock.calls[0];
    expect(request).toEqual({
      routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
      input: [
        { role: 'system', content: [{ type: 'text', text: 'Be concise.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
      labels: { product: 'mention', feature: 'test-feature' },
      temperature: 0.2,
      maxOutputTokens: 128,
    });
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('routingProfile');
    expect(request).not.toHaveProperty('authorizedRoutes');
    expect(options).toMatchObject({ delegatedUserId: 'user-123' });
  });

  it('fails closed unless both the exact routing profile ID and service identity exist', async () => {
    state.config.inference.routingProfileId = undefined;
    expect(isInferenceEnabled()).toBe(false);
    await expect(inferenceChat(
      [{ role: 'user', content: 'Hello' }],
      { feature: 'test-feature' },
    )).rejects.toThrow('OXY_INFERENCE_ROUTING_PROFILE_ID');

    state.config.inference.routingProfileId = '01a06477-94f5-74f0-bc25-4c5c13b93ccd';
    state.credentials.apiKey = undefined;
    state.credentials.apiSecret = undefined;
    expect(isInferenceEnabled()).toBe(false);

    state.credentials.apiKey = 'application-id';
    state.credentials.apiSecret = 'application-secret';
    expect(isInferenceEnabled()).toBe(true);
  });

  it('unwraps fenced JSON without weakening parse failures', async () => {
    state.respond.mockResolvedValueOnce({
      output: [{ role: 'assistant', content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }] }],
    });
    await expect(inferenceJSON<{ ok: boolean }>(
      [{ role: 'user', content: 'Return JSON' }],
      { feature: 'test-json' },
    )).resolves.toEqual({ ok: true });

    state.respond.mockResolvedValueOnce({
      output: [{ role: 'assistant', content: [{ type: 'text', text: 'not-json' }] }],
    });
    await expect(inferenceJSON(
      [{ role: 'user', content: 'Return JSON' }],
      { feature: 'test-json' },
    )).rejects.toThrow('invalid JSON');
  });
});
