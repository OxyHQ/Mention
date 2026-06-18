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

import { extractPublicProfileData } from '../../utils/userSettings';

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
