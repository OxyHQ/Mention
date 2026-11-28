import { resolveUseMemoryFeed } from '../../utils/feedMemoryMode';
import { isDbAvailable as isNativeDbAvailable } from '../database.native';
import { isDbAvailable as isWebDbAvailable } from '../database.web';

describe('SQLite platform availability', () => {
  it('keeps web in network-only memory mode', () => {
    expect(isWebDbAvailable()).toBe(false);
    expect(resolveUseMemoryFeed(false, isWebDbAvailable())).toBe(true);
  });

  it('uses SQLite on native builds', () => {
    expect(isNativeDbAvailable()).toBe(true);
    expect(resolveUseMemoryFeed(false, isNativeDbAvailable())).toBe(false);
  });

  it('keeps scoped feeds in memory regardless of platform persistence', () => {
    expect(resolveUseMemoryFeed(true, isNativeDbAvailable())).toBe(true);
    expect(resolveUseMemoryFeed(true, isWebDbAvailable())).toBe(true);
  });
});
