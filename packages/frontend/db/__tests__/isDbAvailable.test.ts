import { isDbAvailable as isNativeDbAvailable } from '../database.native';
import {
  getDb as getWebDb,
  isDbAvailable as isWebDbAvailable,
  resetDb as resetWebDb,
} from '../database.web';

describe('SQLite platform availability', () => {
  it('keeps web network-only', () => {
    expect(isWebDbAvailable()).toBe(false);
    expect(getWebDb()).toBeNull();
    expect(() => resetWebDb()).not.toThrow();
  });

  it('uses SQLite on native builds', () => {
    expect(isNativeDbAvailable()).toBe(true);
  });
});
