/**
 * Jest stand-in for `@oxy.so/bloom/icons` (mapped in package.json).
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
