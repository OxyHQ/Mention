import { beforeAll, describe, it, expect } from 'vitest';

/**
 * Task 3 — the custom-feed write-payload builders whitelist the request body,
 * validate the composable definition, and never surface owner/aggregate fields.
 */

import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { registerAllModules } from '../mtn/feed/engine';
import { buildCustomFeedCreatePayload, buildCustomFeedUpdatePatch } from '../routes/customFeedWrite';

const registry = new FeedModuleRegistry();
beforeAll(() => registerAllModules(registry));

const validDefinition = {
  mode: 'chronological',
  sources: [{ module: 'keywords', enabled: true, params: { hashtags: ['comics'] } }],
  signals: [],
  filters: [],
};

describe('buildCustomFeedCreatePayload', () => {
  it('builds a whitelisted payload and drops mass-assignment attempts', () => {
    const result = buildCustomFeedCreatePayload(
      {
        title: '  Comics  ',
        description: '  best comics  ',
        visibility: 'public',
        icon: 'sparkles',
        definition: validDefinition,
        // Mass-assignment attempts — must be ignored.
        ownerOxyUserId: 'attacker',
        subscriberCount: 9999,
        averageRating: 5,
      },
      { registry },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      title: 'Comics',
      description: 'best comics',
      isPublic: true,
      icon: 'sparkles',
      definition: { mode: 'chronological', sources: validDefinition.sources, signals: [], filters: [] },
    });
    expect(result.payload).not.toHaveProperty('ownerOxyUserId');
    expect(result.payload).not.toHaveProperty('subscriberCount');
  });

  it('maps visibility=private to isPublic=false and defaults to private', () => {
    const priv = buildCustomFeedCreatePayload({ title: 'x', visibility: 'private', definition: validDefinition }, { registry });
    expect(priv.ok && priv.payload.isPublic).toBe(false);
    const def = buildCustomFeedCreatePayload({ title: 'x', definition: validDefinition }, { registry });
    expect(def.ok && def.payload.isPublic).toBe(false);
  });

  it('rejects a missing title', () => {
    const result = buildCustomFeedCreatePayload({ definition: validDefinition }, { registry });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing/invalid definition', () => {
    expect(buildCustomFeedCreatePayload({ title: 'x' }, { registry }).ok).toBe(false);
    const bad = buildCustomFeedCreatePayload(
      { title: 'x', definition: { mode: 'chronological', sources: [{ module: 'following', enabled: true }], signals: [], filters: [] } },
      { registry },
    );
    expect(bad.ok).toBe(false);
  });
});

describe('buildCustomFeedUpdatePatch', () => {
  it('patches only provided fields', () => {
    const result = buildCustomFeedUpdatePatch({ title: 'New', visibility: 'private' }, { registry });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({ title: 'New', isPublic: false });
    expect(result.payload).not.toHaveProperty('definition');
  });

  it('validates a provided definition', () => {
    const ok = buildCustomFeedUpdatePatch({ definition: validDefinition }, { registry });
    expect(ok.ok).toBe(true);
    const bad = buildCustomFeedUpdatePatch(
      { definition: { mode: 'ranked', sources: [], signals: [], filters: [] } },
      { registry },
    );
    expect(bad.ok).toBe(false); // no enabled source
  });

  it('clears description/icon on explicit null', () => {
    const result = buildCustomFeedUpdatePatch({ description: null, icon: null }, { registry });
    expect(result.ok && result.payload).toEqual({ description: '', icon: '' });
  });

  it('returns an empty patch for an empty body', () => {
    const result = buildCustomFeedUpdatePatch({}, { registry });
    expect(result.ok && result.payload).toEqual({});
  });
});
