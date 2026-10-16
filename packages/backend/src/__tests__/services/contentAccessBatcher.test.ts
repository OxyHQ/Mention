import { describe, expect, it, mock } from 'bun:test';
import type { ContentAccessBatchInput } from '@oxy.so/contracts';

const contentAccessBatch = mock(async (input: ContentAccessBatchInput) => ({
  items: input.items.map((item) => ({
    resourceId: item.resourceId,
    decision: { allowed: true, reason: 'allowed' as const, policyVersion: '2' as const },
  })),
}));
mock.module('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ safety: { contentAccessBatch } }),
}));

const { canSeeUnratedMaterial, decideContentAccess, runWithContentAccessScope } = await import(
  '../../services/contentAccessBatcher'
);

const anonymous = { accessToken: null };
const post = (id: string) => ({ resourceId: id, classification: 'unrated' as const });

describe('request-scoped content decisions', () => {
  it('asks Oxy once per request for concurrent and repeated questions', async () => {
    contentAccessBatch.mockClear();
    await runWithContentAccessScope(async () => {
      await Promise.all([
        decideContentAccess([post('a'), post('b')], anonymous),
        canSeeUnratedMaterial(anonymous),
      ]);
      // Already answered in this request: no further call.
      await decideContentAccess([post('a')], anonymous);
      expect(await canSeeUnratedMaterial(anonymous)).toBe(true);
    });
    expect(contentAccessBatch).toHaveBeenCalledTimes(1);

    // A new request decides again.
    await runWithContentAccessScope(() => decideContentAccess([post('a')], anonymous));
    expect(contentAccessBatch).toHaveBeenCalledTimes(2);
  });

  it('fails closed and never remembers a failure as an answer', async () => {
    contentAccessBatch.mockClear();
    contentAccessBatch.mockImplementationOnce(async () => {
      throw new Error('policy unavailable');
    });
    await runWithContentAccessScope(async () => {
      await expect(decideContentAccess([post('a')], anonymous)).rejects.toThrow(
        'policy unavailable',
      );
      const decisions = await decideContentAccess([post('a')], anonymous);
      expect(decisions.get('a')?.allowed).toBe(true);
    });
    expect(contentAccessBatch).toHaveBeenCalledTimes(2);
  });
});
