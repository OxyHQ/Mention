import fs from 'node:fs';
import path from 'node:path';

/** Installed package, not just our patch text: bun must actually apply the fix. */
it('skips synchronous prop updates for views that no longer exist', () => {
  const packageRoot = path.dirname(require.resolve('react-native-reanimated/package.json'));
  const implementation = fs.readFileSync(path.join(packageRoot, 'android/src/main/java/com/swmansion/reanimated/NativeProxy.kt'), 'utf8');
  expect(implementation).toContain('if (getViewExistsMethod.invoke(mountingManager, viewTag) == true) {');
});
