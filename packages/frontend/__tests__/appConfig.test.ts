type ExpoConfigResult = {
  expo: {
    android?: {
      intentFilters?: {
        data?: ({ host?: string } | false)[];
      }[];
    };
    web?: {
      meta?: {
        viewport?: string;
      };
    };
  };
};

const buildConfig = require('../app.config.js') as (config: object) => ExpoConfigResult;

const originalPublicEnv = process.env.EXPO_PUBLIC_ENV;

afterEach(() => {
  if (originalPublicEnv === undefined) {
    delete process.env.EXPO_PUBLIC_ENV;
  } else {
    process.env.EXPO_PUBLIC_ENV = originalPublicEnv;
  }
});

function intentHosts(result: ExpoConfigResult): string[] {
  return (result.expo.android?.intentFilters ?? [])
    .flatMap((filter) => filter.data ?? [])
    .filter((entry): entry is { host?: string } => Boolean(entry))
    .map((entry) => entry.host ?? '');
}

describe('app config environment matrix', () => {
  it.each(['production', 'testflight'])(
    'does not ship local Android intent hosts in %s',
    (environment) => {
      process.env.EXPO_PUBLIC_ENV = environment;
      const result = buildConfig({});

      expect(intentHosts(result).some((host) => host.includes('localhost'))).toBe(false);
      expect(intentHosts(result).some((host) => host.startsWith('192.168.'))).toBe(false);
    },
  );

  it('keeps local intent hosts in development', () => {
    process.env.EXPO_PUBLIC_ENV = 'development';
    expect(intentHosts(buildConfig({}))).toContain('localhost:3001');
  });

  it('allows browser zoom', () => {
    process.env.EXPO_PUBLIC_ENV = 'production';
    const viewport = buildConfig({}).expo.web?.meta?.viewport ?? '';

    expect(viewport).not.toContain('user-scalable=no');
    expect(viewport).not.toContain('maximum-scale');
  });

  it('rejects unknown environments instead of silently enabling development hosts', () => {
    process.env.EXPO_PUBLIC_ENV = 'prod';

    expect(() => buildConfig({})).toThrow(
      'Invalid EXPO_PUBLIC_ENV "prod". Expected one of: development, testflight, production',
    );
  });
});
