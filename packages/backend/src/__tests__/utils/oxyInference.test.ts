import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: {
    oxyApiUrl: 'https://api.oxy.test',
    inference: { routingProfile: 'mention-default' as string | undefined, timeoutMs: 1_000 },
  },
  credentials: {
    token: 'service-token' as string | undefined,
    apiKey: undefined as string | undefined,
    apiSecret: undefined as string | undefined,
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
    state.config.inference.routingProfile = 'mention-default';
    state.credentials.token = 'service-token';
    state.credentials.apiKey = undefined;
    state.credentials.apiSecret = undefined;
    state.respond.mockResolvedValue({
      output: [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }],
    });
  });

  it('submits only a routing profile and product labels, delegating the end user', async () => {
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
      routingProfile: 'mention-default',
      input: [
        { role: 'system', content: [{ type: 'text', text: 'Be concise.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
      labels: { product: 'mention', feature: 'test-feature' },
      temperature: 0.2,
      maxOutputTokens: 128,
    });
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('authorizedRoutes');
    expect(options).toMatchObject({ delegatedUserId: 'user-123' });
  });

  it('fails closed unless both a routing profile and service identity exist', async () => {
    state.config.inference.routingProfile = undefined;
    expect(isInferenceEnabled()).toBe(false);
    await expect(inferenceChat(
      [{ role: 'user', content: 'Hello' }],
      { feature: 'test-feature' },
    )).rejects.toThrow('OXY_INFERENCE_ROUTING_PROFILE');

    state.config.inference.routingProfile = 'mention-default';
    state.credentials.token = undefined;
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
