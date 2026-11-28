import path from 'node:path';
import { compile } from 'react-native-css/compiler';

type ColorMix = (resolve: (value: unknown) => unknown, descriptor: unknown[]) => unknown;
const packageRoot = path.dirname(require.resolve('react-native-css/package.json'));

function findMix(value: unknown): unknown[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value) && value[1] === 'colorMix') return value;
  for (const child of Object.values(value)) {
    const match = findMix(child);
    if (match) return match;
  }
  return undefined;
}

// The variable resolver boundary supplies the known white token. Compilation,
// native JSON serialization, and each installed distribution's mix evaluator run.
for (const format of ['commonjs', 'module']) {
  const { colorMix } = jest.requireActual<{ colorMix: ColorMix }>(
    path.join(packageRoot, 'dist', format, 'native/styles/functions/color-mix.js'),
  );
  describe(`installed native CSS ${format} color-mix`, () => {
    it.each([
      ['50%, transparent', 0.5],
      [', transparent 75%', 0.25],
      [', transparent', 0.5],
    ])('preserves omitted weights through Metro JSON injection (%s)', (tail, alpha) => {
      const compiled = compile(
        `:root { --white: #fff; } .test { color: color-mix(in oklab, var(--white) ${tail}); }`,
        { inlineVariables: false },
      ).stylesheet();
      const serialized: unknown = JSON.parse(JSON.stringify(compiled.s));
      const descriptor = findMix(serialized);
      expect(descriptor).toBeDefined();
      if (!descriptor) throw new Error('Compiler did not emit a dynamic color mix');
      expect(
        colorMix((values) => {
          if (!Array.isArray(values)) throw new Error('Expected mix arguments');
          return values.map((value: unknown) =>
            Array.isArray(value) && value[1] === 'var' ? '#fff' : value,
          );
        }, descriptor),
      ).toBe(`rgba(255, 255, 255, ${alpha})`);
    });
  });
}
