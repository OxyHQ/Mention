import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { publicApiUrl: 'https://api.mention.earth' },
}));

const getFileDownloadUrl = vi.fn((fileId: string, variant?: string) => {
  const qs = variant ? `?variant=${variant}` : '';
  return `https://api.oxy.so/assets/${encodeURIComponent(fileId)}/stream${qs}`;
});

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getBaseURL: () => 'https://api.oxy.so',
    getFileDownloadUrl,
  }),
}));

import { buildSettingsResponseForViewer, extractPublicProfileData } from '../../utils/userSettings';

describe('extractPublicProfileData', () => {
  it('exposes profileHeaderImage as the canonical resolved banner field', () => {
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
      'https://api.oxy.so/assets/new-banner-file/stream',
    );
    expect(result.profileCustomization).toEqual({
      coverPhotoEnabled: true,
      minimalistMode: false,
    });
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

    expect(buildSettingsResponseForViewer(doc, 'user-1', 'user-1')).toBe(doc);
  });

  it('suppresses profile design data for cross-user settings responses without profile access', () => {
    const result = buildSettingsResponseForViewer(
      {
        oxyUserId: 'target-user',
        appearance: { themeMode: 'system', primaryColor: '#00f' },
        profileHeaderImage: 'private-banner-file',
        profileCustomization: {
          coverPhotoEnabled: true,
          minimalistMode: false,
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
      privacy: { profileVisibility: 'private' },
    });
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
    );

    expect(result).toBeTruthy();
    expect(result).toEqual({
      oxyUserId: 'target-user',
      appearance: { primaryColor: '#00f' },
      profileHeaderImage: 'https://api.oxy.so/assets/banner-file/stream',
      profileCustomization: {
        coverPhotoEnabled: true,
        minimalistMode: false,
      },
    });
    if (result) {
      expect('privacy' in result).toBe(false);
    }
  });
});
