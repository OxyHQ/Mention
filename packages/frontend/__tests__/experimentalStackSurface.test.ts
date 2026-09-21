import fs from 'node:fs';
import path from 'node:path';

/** Installed package, not just our patch text: bun must actually apply the fix. */
it('leaves the central surface to Bloom and honors hidden native headers', () => {
  const packageRoot = path.dirname(require.resolve('expo-router/package.json'));
  const implementation = fs.readFileSync(path.join(packageRoot, 'build/layouts/experimental-stack/ExperimentalStackView.js'), 'utf8');
  expect(implementation).toMatch(/scene:\s*\{\s*flex:\s*1,\s*backgroundColor:\s*'transparent'/);
  expect(implementation).toContain('options.headerShown === false ? null');
});
