import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const SERVICES_PACKAGE = require.resolve('@oxyhq/services/package.json');
const SERVICES_ROOT = dirname(SERVICES_PACKAGE);

describe('Oxy runtime compatibility unit', () => {
  it.each([
    ['@alia.onl/sdk', 'useOxy'],
    ['@syra.fm/sdk', 'useAuth'],
  ])('%s resolves its Services peer to the app singleton', (sdk, hook) => {
    const sdkPackage = require.resolve(`${sdk}/package.json`);
    const sdkRoot = dirname(sdkPackage);
    const sdkRequire = createRequire(sdkPackage);

    expect(sdkRequire.resolve('@oxyhq/services/package.json')).toBe(SERVICES_PACKAGE);
    expect(existsSync(join(sdkRoot, 'node_modules', '@oxyhq', 'services', 'package.json'))).toBe(false);

    const servicesTypes = readFileSync(
      join(SERVICES_ROOT, 'lib', 'typescript', 'commonjs', 'index.d.ts'),
      'utf8',
    );
    expect(servicesTypes).toMatch(new RegExp(`export \\{ ${hook} \\}`));
  });

  it('gives Services the same Core and Bloom runtime as Mention', () => {
    const servicesRequire = createRequire(SERVICES_PACKAGE);

    expect(servicesRequire.resolve('@oxyhq/core/package.json')).toBe(
      require.resolve('@oxyhq/core/package.json'),
    );
    expect(servicesRequire.resolve('@oxyhq/bloom/package.json')).toBe(
      require.resolve('@oxyhq/bloom/package.json'),
    );
  });
});
