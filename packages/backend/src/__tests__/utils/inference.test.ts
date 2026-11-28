import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: {
    inference: { timeoutMs: 1_000 },
  },
  create: vi.fn(),
  factory: vi.fn(),
  dispose: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../config', () => ({
  config: state.config,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ identity: 'own-workload' }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: state.logError },
}));

vi.mock('@kaana.ai/sdk/server', () => ({
  kaanaForOxyService: (oxy: unknown, options: unknown) => {
    state.factory(oxy, options);
    return { responses: { create: state.create }, dispose: state.dispose };
  },
}));

import { inferenceChat, inferenceJSON } from '../../utils/inference';
import { resetKaanaClient } from '../../utils/kaana';

describe('Kaana inference boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetKaanaClient();
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
    expect(state.factory).toHaveBeenCalledWith(
      { identity: 'own-workload' },
      { attribution: { accountId: 'user-123' }, maxRetries: 0 },
    );
    expect(state.dispose).toHaveBeenCalledOnce();
  });

  it('surfaces failed attestation from the shared client without a customer-key fallback', async () => {
    state.create.mockRejectedValueOnce(new Error('workload attestation refused'));
    await expect(
      inferenceChat([{ role: 'user', content: 'Hello' }], { feature: 'test' }),
    ).rejects.toThrow('workload attestation refused');
    expect(state.create).toHaveBeenCalledOnce();
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
