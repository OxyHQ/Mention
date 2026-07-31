import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { publicApiUrl: 'https://api.mention.earth' },
}));

const getFileDownloadUrl = vi.fn((fileId: string, variant?: string) => {
  const qs = variant ? `?variant=${variant}` : '';
  return `https://cloud.oxy.so/${encodeURIComponent(fileId)}${qs}`;
});

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getBaseURL: () => 'https://api.oxy.so',
    getCloudURL: () => 'https://cloud.oxy.so',
    getFileDownloadUrl,
  }),
}));

import { buildSettingsResponseForViewer, extractPublicProfileData } from '../../utils/userSettings';

// The banner is a full-bleed 170px strip, so the DTO must carry the banner
// VARIANT and never the no-variant original — that original is the raw upload
// (megabytes of camera-roll PNG) and it is what the profile screen renders.
describe('extractPublicProfileData', () => {
  it('resolves a bare file id to the banner variant, not the original', () => {
    const result = extractPublicProfileData(
      {
        profileHeaderImage: 'new-banner-file',
        profileCustomization: {
          coverPhotoEnabled: true,
          minimalistMode: false,
        },
      },
      'user-1',
    );

    expect(result.profileHeaderImage).toBe(
      'https://cloud.oxy.so/new-banner-file?variant=w1280',
    );
    expect(result.profileCustomization).toEqual({
      coverPhotoEnabled: true,
      minimalistMode: false,
    });
  });

  it('attaches the banner variant to an already-absolute Oxy CDN url', () => {
    const result = extractPublicProfileData(
      { profileHeaderImage: 'https://cloud.oxy.so/legacy-banner-file' },
      'user-1',
    );

    expect(result.profileHeaderImage).toBe(
      'https://cloud.oxy.so/legacy-banner-file?variant=w1280',
    );
  });

  it('proxies a genuinely external banner url, which has no variant system', () => {
    const result = extractPublicProfileData(
      { profileHeaderImage: 'https://remote.example/header.jpg' },
      'user-1',
    );

    expect(result.profileHeaderImage).toBe(
      'https://api.mention.earth/media/proxy?url=https%3A%2F%2Fremote.example%2Fheader.jpg',
    );
  });

  it('omits the field when no banner is set', () => {
    expect(extractPublicProfileData({}, 'user-1').profileHeaderImage).toBeUndefined();
  });
});

describe('buildSettingsResponseForViewer', () => {
  it('returns the full settings document to the owner', () => {
    const doc = {
      oxyUserId: 'user-1',
      privacy: {
        profileVisibility: 'public' as const,
        showSensitiveContent: true,
        hiddenWords: ['private'],
      },
    };

    expect(
      buildSettingsResponseForViewer(doc, 'user-1', 'user-1', { canViewProfileDesign: true }),
    ).toBe(doc);
  });

  it('redacts private preferences from cross-user settings responses', () => {
    const result = buildSettingsResponseForViewer(
      {
        oxyUserId: 'target-user',
        appearance: { themeMode: 'system', primaryColor: '#00f' },
        profileHeaderImage: 'banner-file',
        profileCustomization: {
          coverPhotoEnabled: true,
          minimalistMode: false,
        },
        privacy: {
          profileVisibility: 'public',
          showSensitiveContent: true,
          hiddenWords: ['private'],
          restrictedUsers: ['blocked-user'],
        },
      },
      'target-user',
      'viewer-user',
      { canViewProfileDesign: true },
    );

    expect(result).toBeTruthy();
    expect(result).toEqual({
      oxyUserId: 'target-user',
      appearance: { primaryColor: '#00f' },
      profileHeaderImage: 'https://cloud.oxy.so/banner-file?variant=w1280',
      profileCustomization: {
        coverPhotoEnabled: true,
        minimalistMode: false,
      },
    });
    if (result) {
      expect('privacy' in result).toBe(false);
    }
  });

  // The design fields are gated on the target's profile visibility. The caller
  // resolves that rule (`canViewProfileDesign` in utils/privacyHelpers); this
  // asserts the DTO honours a denial rather than falling back to the full
  // payload — the fail-open shape a defaulted option would have produced.
  it('suppresses every design field when the viewer has no profile access', () => {
    const result = buildSettingsResponseForViewer(
      {
        oxyUserId: 'target-user',
        appearance: { themeMode: 'system', primaryColor: '#00f' },
        profileHeaderImage: 'banner-file',
        profileCustomization: {
          coverPhotoEnabled: true,
          minimalistMode: false,
          profileMedia: {
            type: 'podcast',
            syraPodcastId: 'show-1',
            title: 'A private show',
            artworkUrl: 'https://cdn.syra.fm/artwork.jpg',
            showUrl: 'https://syra.fm/show-1',
          },
        },
        privacy: {
          profileVisibility: 'private',
          showSensitiveContent: true,
          hiddenWords: ['private'],
        },
      },
      'target-user',
      'viewer-user',
      { canViewProfileDesign: false },
    );

    expect(result).toEqual({
      oxyUserId: 'target-user',
      appearance: undefined,
      profileHeaderImage: undefined,
      profileCustomization: undefined,
      profileMedia: undefined,
    });
  });
});
