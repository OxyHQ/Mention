import fs from 'node:fs';
import path from 'node:path';

/**
 * The installed package, read as shipped. Mention patched this guard in until
 * Reanimated 4.7 shipped it upstream (software-mansion/react-native-reanimated#10435);
 * this keeps a downgrade from silently bringing the warnings back (#1126).
 */
it('skips synchronous prop updates for views that no longer exist', () => {
  const packageRoot = path.dirname(require.resolve('react-native-reanimated/package.json'));
  const implementation = fs.readFileSync(
    path.join(packageRoot, 'android/src/main/java/com/swmansion/reanimated/NativeProxy.kt'),
    'utf8',
  );
  expect(implementation).toContain(
    'if (getViewExistsMethod?.invoke(mountingManager, viewTag) == false) {',
  );
});
