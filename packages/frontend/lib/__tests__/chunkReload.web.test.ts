import { isChunkLoadError } from '../chunkReload.web';

jest.mock('@oxy.so/core/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

describe('isChunkLoadError', () => {
  it.each([
    ['a Metro async-require failure', Object.assign(new Error('x'), { name: 'AsyncRequireError' })],
    ['a webpack-style chunk failure', new Error('Loading chunk 12 failed.')],
    [
      'a dynamic import failure',
      new TypeError('Failed to fetch dynamically imported module: https://x/y.js'),
    ],
    // The 2026-09-30 outage: the shared chunk 404ed, so the first module that
    // needed something from it threw this.
    ['a module from a chunk that never loaded', new Error('Requiring unknown module "908".')],
  ])('recognises %s', (_label, error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    ['an ordinary error', new Error('Network request failed')],
    ['nothing', null],
    ['a string that is not a chunk failure', 'boom'],
  ])('ignores %s', (_label, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});
