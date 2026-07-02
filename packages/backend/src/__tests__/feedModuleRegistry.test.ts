import { describe, it, expect, beforeEach } from 'vitest';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type { SourceModule, SignalModule, FilterModule } from '../mtn/feed/engine/types';

const fakeSource: SourceModule = {
  id: 'fake-source',
  kind: 'source',
  userComposable: true,
  gather: async () => [],
};

const fakeSignal: SignalModule = {
  id: 'fake-signal',
  kind: 'signal',
  weightKey: 'engagement',
};

const fakeFilter: FilterModule = {
  id: 'fake-filter',
  kind: 'filter',
  keep: () => true,
};

describe('FeedModuleRegistry', () => {
  let registry: FeedModuleRegistry;

  beforeEach(() => {
    registry = new FeedModuleRegistry();
    registry.register(fakeSource);
    registry.register(fakeSignal);
    registry.register(fakeFilter);
  });

  it('resolves a registered source/signal/filter by id', () => {
    expect(registry.getSource('fake-source')).toBe(fakeSource);
    expect(registry.getSignal('fake-signal')).toBe(fakeSignal);
    expect(registry.getFilter('fake-filter')).toBe(fakeFilter);
  });

  it('reports registration via has()', () => {
    expect(registry.has('fake-source')).toBe(true);
    expect(registry.has('fake-signal')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
  });

  it('returns undefined for an unknown id', () => {
    expect(registry.getSource('nope')).toBeUndefined();
    expect(registry.getSignal('nope')).toBeUndefined();
    expect(registry.getFilter('nope')).toBeUndefined();
  });

  it('returns undefined on a kind-mismatched lookup', () => {
    // A source id looked up as a signal (or filter) must not resolve.
    expect(registry.getSignal('fake-source')).toBeUndefined();
    expect(registry.getFilter('fake-source')).toBeUndefined();
    expect(registry.getSource('fake-signal')).toBeUndefined();
    expect(registry.getFilter('fake-signal')).toBeUndefined();
    expect(registry.getSource('fake-filter')).toBeUndefined();
    expect(registry.getSignal('fake-filter')).toBeUndefined();
  });

  it('overwrites a module registered under the same id', () => {
    const replacement: SourceModule = { ...fakeSource, userComposable: false };
    registry.register(replacement);
    expect(registry.getSource('fake-source')).toBe(replacement);
  });
});
