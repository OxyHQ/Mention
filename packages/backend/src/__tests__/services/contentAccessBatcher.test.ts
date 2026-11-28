// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
  '../../services/moderation/contentAccessBatcher'
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

  it('keeps first-party account decisions separate from each other and anonymous decisions', async () => {
    contentAccessBatch.mockClear();
    const first = { actingForAccountId: 'first-account' };
    const second = { actingForAccountId: 'second-account' };
    await runWithContentAccessScope(async () => {
      await Promise.all([
        decideContentAccess([post('same-post')], first),
        decideContentAccess([post('same-post')], second),
        decideContentAccess([post('same-post')], anonymous),
      ]);
      await decideContentAccess([post('same-post')], first);
    });
    expect(contentAccessBatch).toHaveBeenCalledTimes(3);
    for (const requester of [first, second, anonymous]) {
      expect(contentAccessBatch).toHaveBeenCalledWith({ items: [post('same-post')] }, requester);
    }
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
