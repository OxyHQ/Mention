/**
 * Tests run under either jest (frontend `jest-expo` preset) or vitest (workspace
 * runner). Both provide the same describe/it/expect globals.
 *
 * `@oxyhq/core`'s package entry pulls in the full runtime graph (crypto
 * polyfills, etc.), which is too heavy for a pure-logic util test. We only need
 * the real `normalizeProfileLinks`, which lives in a dependency-free submodule,
 * so we load that submodule directly by file path (bypassing the exports map)
 * and expose it as the mocked module. This exercises the REAL function — not a
 * reimplementation — without importing the rest of core.
 */
jest.mock('@oxyhq/core', () => {
  const path = require('path');
  const pkgRoot = path.resolve(path.dirname(require.resolve('@oxyhq/core')), '../..');
  return require(path.join(pkgRoot, 'dist/cjs/utils/profileLinks.js'));
});

// eslint-disable-next-line import/first
import { mergeBioAndProfileLinks } from '../mergeBioAndProfileLinks';

describe('mergeBioAndProfileLinks', () => {
  it('returns only the explicit links when there is no bio', () => {
    expect(
      mergeBioAndProfileLinks([{ url: 'https://a.com', title: 'A' }], undefined, undefined),
    ).toEqual([{ id: '0', url: 'https://a.com', title: 'A' }]);
  });

  it('returns explicit links unchanged when the bio has no URLs', () => {
    expect(
      mergeBioAndProfileLinks([{ url: 'https://a.com', title: 'A' }], undefined, 'no links here'),
    ).toEqual([{ id: '0', url: 'https://a.com', title: 'A' }]);
  });

  it('appends bio-only URLs in bio order (no explicit links)', () => {
    expect(
      mergeBioAndProfileLinks(undefined, undefined, 'see https://b.com and www.c.com'),
    ).toEqual([
      { id: 'bio-0', url: 'https://b.com' },
      { id: 'bio-1', url: 'https://www.c.com' },
    ]);
  });

  it('falls back to the legacy links array, then appends bio URLs', () => {
    expect(
      mergeBioAndProfileLinks(undefined, ['https://a.com'], 'plus https://b.com'),
    ).toEqual([
      { id: '0', url: 'https://a.com' },
      { id: 'bio-0', url: 'https://b.com' },
    ]);
  });

  it('keeps explicit links first and appends bio-only URLs after', () => {
    expect(
      mergeBioAndProfileLinks(
        [{ url: 'https://a.com', title: 'A' }],
        undefined,
        'visit https://b.com and www.c.com',
      ),
    ).toEqual([
      { id: '0', url: 'https://a.com', title: 'A' },
      { id: 'bio-0', url: 'https://b.com' },
      { id: 'bio-1', url: 'https://www.c.com' },
    ]);
  });

  it('dedupes a bio URL that matches an explicit link (explicit wins, keeps metadata)', () => {
    expect(
      mergeBioAndProfileLinks(
        [{ url: 'https://a.com', title: 'A' }],
        undefined,
        'visit https://a.com and www.b.com',
      ),
    ).toEqual([
      { id: '0', url: 'https://a.com', title: 'A' },
      { id: 'bio-0', url: 'https://www.b.com' },
    ]);
  });

  it('dedupes ignoring scheme, www., trailing slash, and host case', () => {
    expect(
      mergeBioAndProfileLinks(
        [{ url: 'https://A.com/', title: 'A' }],
        undefined,
        'mirror at https://www.a.com',
      ),
    ).toEqual([{ id: '0', url: 'https://A.com/', title: 'A' }]);
  });

  it('dedupes repeated bio URLs', () => {
    expect(
      mergeBioAndProfileLinks(undefined, undefined, 'https://b.com then https://b.com again'),
    ).toEqual([{ id: 'bio-0', url: 'https://b.com' }]);
  });

  it('returns an empty array with no links and no bio', () => {
    expect(mergeBioAndProfileLinks(undefined, undefined, undefined)).toEqual([]);
  });
});
