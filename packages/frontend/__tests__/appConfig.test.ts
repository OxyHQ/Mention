type ExpoConfigResult = {
  expo: {
    android?: {
      intentFilters?: {
        data?: ({ scheme?: string; host?: string; port?: string } | false)[];
      }[];
    };
    web?: {
      meta?: {
        viewport?: string;
      };
    };
  };
};

const buildConfig = jest.requireActual('../app.config.js') as (config: object) => ExpoConfigResult;

const originalPublicEnv = process.env.EXPO_PUBLIC_ENV;
const originalDevHost = process.env.EXPO_PUBLIC_DEV_HOST;

afterEach(() => {
  if (originalPublicEnv === undefined) {
    delete process.env.EXPO_PUBLIC_ENV;
  } else {
    process.env.EXPO_PUBLIC_ENV = originalPublicEnv;
  }
  if (originalDevHost === undefined) {
    delete process.env.EXPO_PUBLIC_DEV_HOST;
  } else {
    process.env.EXPO_PUBLIC_DEV_HOST = originalDevHost;
  }
});

function intentEntries(result: ExpoConfigResult): { scheme?: string; host?: string; port?: string }[] {
  return (result.expo.android?.intentFilters ?? [])
    .flatMap((filter) => filter.data ?? [])
    .filter((entry): entry is { scheme?: string; host?: string; port?: string } => Boolean(entry));
}

describe('app config environment matrix', () => {
  it.each(['production', 'testflight'])(
    'does not ship local Android intent hosts in %s',
    (environment) => {
      process.env.EXPO_PUBLIC_ENV = environment;
      process.env.EXPO_PUBLIC_DEV_HOST = '192.168.86.44';
      const result = buildConfig({});
      const hosts = intentEntries(result).map((entry) => entry.host ?? '');

      expect(hosts.some((host) => host.includes('localhost'))).toBe(false);
      expect(hosts.some((host) => host.startsWith('192.168.'))).toBe(false);
    },
  );

  it('keeps local intent hosts in development', () => {
    process.env.EXPO_PUBLIC_ENV = 'development';
    expect(intentEntries(buildConfig({}))).toContainEqual({
      scheme: 'http',
      host: 'localhost',
      port: '3001',
    });
  });

  it('adds only an explicitly configured development host', () => {
    process.env.EXPO_PUBLIC_ENV = 'development';
    process.env.EXPO_PUBLIC_DEV_HOST = '192.168.86.44';

    expect(intentEntries(buildConfig({}))).toEqual(
      expect.arrayContaining([
        { scheme: 'http', host: '192.168.86.44', port: '3000' },
        { scheme: 'http', host: '192.168.86.44', port: '3001' },
      ]),
    );
  });

  it('rejects a development host containing a scheme or port', () => {
    process.env.EXPO_PUBLIC_ENV = 'development';
    process.env.EXPO_PUBLIC_DEV_HOST = 'http://localhost:3000';

    expect(() => buildConfig({})).toThrow(
      'Invalid EXPO_PUBLIC_DEV_HOST. Provide a hostname or IP without a scheme or port.',
    );
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
