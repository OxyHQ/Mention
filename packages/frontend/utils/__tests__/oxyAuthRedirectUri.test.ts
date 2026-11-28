/**
 * @jest-environment jsdom
 */
import {
  chooseOxyAuthRedirectUri,
  MENTION_WEB_ORIGINS,
  resolveOxyAuthRedirectUri,
} from '../oxyAuthRedirectUri';

const mockPlatform = { OS: 'web' };
// A getter: the factory runs before `mockPlatform` is initialised (jest.mock hoists).
jest.mock('react-native', () => ({
  get Platform() {
    return mockPlatform;
  },
}));
jest.mock('@/config', () => ({ OXY_AUTH_REDIRECT_URI: 'https://mention.earth' }));

afterEach(() => {
  mockPlatform.OS = 'web';
  jest.restoreAllMocks();
});

/** Serve the page from `origin` for one assertion. */
function onOrigin(origin: string): void {
  jest.spyOn(window, 'location', 'get').mockReturnValue({ origin } as Location);
}

describe('chooseOxyAuthRedirectUri', () => {
  it('returns to the Mention web origin the page was served on', () => {
    expect(chooseOxyAuthRedirectUri('https://mention.earth', 'https://mention.org')).toBe(
      'https://mention.org',
    );
    expect(chooseOxyAuthRedirectUri('https://mention.earth', 'https://mention.earth')).toBe(
      'https://mention.earth',
    );
    expect(MENTION_WEB_ORIGINS).toEqual(['https://mention.earth', 'https://mention.org']);
  });

  it('keeps the configured URI on any other origin, or with none', () => {
    const configured = 'https://social.alpha.example/oauth/callback';
    for (const origin of [
      'https://social.alpha.example',
      'http://localhost:8110',
      'https://www.mention.org',
      'http://mention.org',
      'https://mention.org.evil.example',
      'null',
      '',
      undefined,
      null,
    ]) {
      expect(chooseOxyAuthRedirectUri(configured, origin)).toBe(configured);
    }
  });
});

describe('resolveOxyAuthRedirectUri', () => {
  it('uses the build-time constant by default and on a non-Mention page', () => {
    // jsdom's own page is http://localhost, which is not a Mention origin.
    expect(resolveOxyAuthRedirectUri()).toBe('https://mention.earth');
    expect(resolveOxyAuthRedirectUri('https://social.alpha.example')).toBe(
      'https://social.alpha.example',
    );
  });

  it('returns to mention.org on web when the page is served there', () => {
    onOrigin('https://mention.org');
    expect(resolveOxyAuthRedirectUri()).toBe('https://mention.org');
  });

  it('keeps the build-time constant on native even if a location exists', () => {
    onOrigin('https://mention.org');
    for (const os of ['android', 'ios']) {
      mockPlatform.OS = os;
      expect(resolveOxyAuthRedirectUri()).toBe('https://mention.earth');
    }
  });
});
