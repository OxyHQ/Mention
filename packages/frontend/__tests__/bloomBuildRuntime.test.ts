/**
 * The Bloom build (`bloom build android`, Package.bloom) and the Expo build ship the same app
 * id and version, so OTA updates keep them apart by runtime version: the Expo build's is the
 * app `version` (withOxyUpdates, appVersion policy), the Bloom build's is `<version>-bloom`
 * (Native/android/res/values/overrides.xml). An update exported from one build's bundle must
 * never land on the other: their native layers differ.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const version: string = JSON.parse(read('package.json')).version;
const packageBloom = read('Package.bloom');
const overrides = read('Native/android/res/values/overrides.xml');

describe('the Bloom build', () => {
  test('has its own OTA runtime: the app version plus "-bloom"', () => {
    const runtime = overrides.match(/name="expo_runtime_version">([^<]+)</)?.[1];
    expect(runtime).toBe(`${version}-bloom`);
  });

  test("ships the app's version and build number", () => {
    const [major, minor, patch] = version.split('.').map(Number);
    expect(packageBloom).toContain(`version: "${version}",`);
    // withOxyReleaseVersion's versionCode: 1.2.3 is 1002003.
    expect(packageBloom).toContain(`build: ${major * 1_000_000 + minor * 1_000 + patch},`);
  });

  test("reads the Expo build's Firebase config", () => {
    const firebase = JSON.parse(read('Native/android/google-services.json'));
    const packages = firebase.client.map(
      (c: { client_info: { android_client_info: { package_name: string } } }) =>
        c.client_info.android_client_info.package_name,
    );
    expect(packages).toContain('org.mention.app');
  });
});
