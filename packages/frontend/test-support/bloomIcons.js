/**
 * Jest stand-in for `@oxy.so/bloom/icons` AND every `@oxy.so/bloom/icons/Ri*`
 * subpath (both mapped in package.json).
 *
 * The subpath mapping matters as much as the barrel one now: app code imports
 * each glyph by subpath, because Metro does not tree-shake and the barrel ships
 * all 461. Bloom resolves those subpaths to untranspiled `src/*.tsx`, which
 * Jest cannot require, so without the mapping every screen that draws an icon
 * fails to load. One Proxy serves both shapes — a subpath module is asked for
 * exactly the one name it exports.
 *
 * Bloom ships that barrel as untranspiled ESM, which Jest cannot require, so a
 * screen importing any icon used to need a per-test `jest.mock` listing every
 * glyph by name — and adding one icon to a screen broke its test. Every export
 * here is a null-rendering component named after the icon, so assertions about
 * which glyph drew can still read `displayName`. A test's own `jest.mock` of the
 * module still takes precedence.
 */
const icons = new Map();

function iconNamed(name) {
  if (!icons.has(name)) {
    const Icon = () => null;
    Icon.displayName = name;
    icons.set(name, Icon);
  }
  return icons.get(name);
}

module.exports = new Proxy(
  { __esModule: true },
  {
    get(target, name) {
      if (name in target) return target[name];
      return typeof name === 'string' && name.startsWith('Ri') ? iconNamed(name) : undefined;
    },
  },
);
