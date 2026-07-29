/**
 * The config plugin that points the Android home-screen widgets at a backend.
 *
 * Its whole job is to write two string resources, and the reason it is worth
 * testing is the failure mode of getting them wrong: a malformed origin does not
 * break the build, it ships — and then fails on a user's home screen, where it
 * reads as a broken widget rather than a misconfigured build. So the validation
 * has to reject at prebuild time, and the write has to actually happen.
 *
 * `expo/config-plugins` is mocked rather than exercised: this is about what the
 * plugin decides, not about Expo's XML plumbing.
 */

type ResourceItem = { name: string; value: string; translatable: boolean };
type StringsXml = { resources: { string?: ResourceItem[] } };
type PluginConfig = { name: string; modResults?: StringsXml };
type StringsMod = (config: PluginConfig) => PluginConfig;

const mockWithStringsXml = jest.fn<PluginConfig, [PluginConfig, StringsMod]>();
const mockSetStringItem = jest.fn<StringsXml, [ResourceItem[], StringsXml]>();
const mockBuildResourceItem = jest.fn<ResourceItem, [ResourceItem]>();

jest.mock('expo/config-plugins', () => ({
  withStringsXml: (config: PluginConfig, mod: StringsMod) => mockWithStringsXml(config, mod),
  AndroidConfig: {
    Strings: {
      setStringItem: (items: ResourceItem[], xml: StringsXml) => mockSetStringItem(items, xml),
    },
    Resources: {
      buildResourceItem: (item: ResourceItem) => mockBuildResourceItem(item),
    },
  },
}));

// A config plugin is a CommonJS module by contract: `app.config.js` `require`s
// it by path at prebuild time, so it cannot be an ES module the test could
// `import`.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
const withMentionWidgets = require('../app.plugin') as ((
  config: PluginConfig,
  options?: { apiBaseUrl?: unknown; webBaseUrl?: unknown },
) => PluginConfig) & {
  assertBaseUrl: (option: string, value: unknown) => void;
};

beforeEach(() => {
  mockWithStringsXml.mockReset();
  mockSetStringItem.mockReset();
  mockBuildResourceItem.mockReset();

  mockBuildResourceItem.mockImplementation((item) => item);
  mockSetStringItem.mockImplementation((items, xml) => ({
    resources: { string: [...(xml.resources.string ?? []), ...items] },
  }));
  // Run the mod immediately so the assertions can look at what it wrote.
  mockWithStringsXml.mockImplementation((config, mod) =>
    mod({ ...config, modResults: { resources: { string: [] } } }),
  );
});

describe('withMentionWidgets', () => {
  it('writes both endpoints as untranslatable app resources', () => {
    const result = withMentionWidgets(
      { name: 'Mention' },
      { apiBaseUrl: 'https://api.example.test', webBaseUrl: 'https://example.test' },
    );

    expect(result.modResults?.resources.string).toEqual([
      {
        name: 'mention_widget_api_base_url',
        value: 'https://api.example.test',
        translatable: false,
      },
      { name: 'mention_widget_web_base_url', value: 'https://example.test', translatable: false },
    ]);
  });

  it('leaves the config alone when nothing is overridden, so the module defaults stand', () => {
    const config = { name: 'Mention' };

    expect(withMentionWidgets(config)).toBe(config);
    expect(mockWithStringsXml).not.toHaveBeenCalled();
  });

  it('writes only the endpoint that was overridden', () => {
    const result = withMentionWidgets({ name: 'Mention' }, { webBaseUrl: 'http://192.168.1.5:3001' });

    expect(result.modResults?.resources.string).toEqual([
      { name: 'mention_widget_web_base_url', value: 'http://192.168.1.5:3001', translatable: false },
    ]);
  });
});

describe('assertBaseUrl', () => {
  it.each([
    ['a relative URL', '/api'],
    ['a scheme-less host', 'api.mention.earth'],
    ['a non-http scheme', 'ftp://api.mention.earth'],
    ['an origin carrying a path', 'https://api.mention.earth/v1'],
    ['an origin carrying a query', 'https://api.mention.earth?x=1'],
    ['an origin carrying a fragment', 'https://api.mention.earth#x'],
    ['an empty string', ''],
    ['untrimmed whitespace', ' https://api.mention.earth '],
    ['a non-string', 42],
  ])('rejects %s', (_case, value) => {
    expect(() => withMentionWidgets.assertBaseUrl('apiBaseUrl', value)).toThrow(/apiBaseUrl/);
  });

  it.each([
    ['the production API origin', 'https://api.mention.earth'],
    ['a bare origin with a trailing slash', 'https://api.mention.earth/'],
    ['a LAN development host', 'http://192.168.1.5:3000'],
  ])('accepts %s', (_case, value) => {
    expect(() => withMentionWidgets.assertBaseUrl('apiBaseUrl', value)).not.toThrow();
  });
});
