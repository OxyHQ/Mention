import { describe, it, expect } from 'bun:test';
import { isValidFeedDescriptor } from '@mention/shared-types';
import { resolveDefinition } from '../mtn/feed/definitions/resolveDefinition';

describe('trend feed ordering', () => {
  it('accepts latest and top as the optional second param, and nothing else', () => {
    expect(isValidFeedDescriptor('trend|nvidia')).toBe(true);
    expect(isValidFeedDescriptor('trend|nvidia|top')).toBe(true);
    expect(isValidFeedDescriptor('trend|nvidia|latest')).toBe(true);
    expect(isValidFeedDescriptor('trend|nvidia|sideways')).toBe(false);
  });

  it('top ranks the same posts by engagement and recency', async () => {
    const top = await resolveDefinition('trend|nvidia|top');
    const latest = await resolveDefinition('trend|nvidia');
    expect(top!.mode).toBe('ranked');
    expect(top!.id).toBe('trend|nvidia|top');
    expect(top!.sources.map((s) => s.module)).toEqual(latest!.sources.map((s) => s.module));
    expect(top!.signals.map((s) => s.module)).toEqual(['engagement', 'recency']);
  });

  it('latest stays chronological, and an unknown order degrades to latest', async () => {
    const latest = await resolveDefinition('trend|nvidia|latest');
    const unknown = await resolveDefinition('trend|nvidia|sideways');
    expect(latest!.mode).toBe('chronological');
    expect(unknown!.id).toBe('trend|nvidia');
  });
});
