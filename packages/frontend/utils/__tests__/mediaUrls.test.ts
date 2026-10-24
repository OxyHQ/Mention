import { proxyExternalUrl, videoPosterUrl } from '../mediaUrls';

jest.mock('@/config', () => ({
  API_URL: 'https://api.mention.test',
  OXY_BASE_URL: 'https://api.oxy.test',
}));

const API = 'https://api.mention.test';
const remote = 'https://video.example/clip.mp4';
const proxied = `${API}/media/proxy?url=${encodeURIComponent(remote)}`;

describe('proxyExternalUrl', () => {
  it('routes a remote URL through the media proxy and leaves ours and non-http alone', () => {
    expect(proxyExternalUrl(remote)).toBe(proxied);
    expect(proxyExternalUrl(proxied)).toBe(proxied);
    expect(proxyExternalUrl('https://api.oxy.test/assets/1')).toBe('https://api.oxy.test/assets/1');
    expect(proxyExternalUrl('https://elsewhere.example/media/proxy?url=x')).toBe(
      'https://elsewhere.example/media/proxy?url=x',
    );
    expect(proxyExternalUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
    expect(proxyExternalUrl('not a url')).toBe('not a url');
  });
});

describe('videoPosterUrl', () => {
  const poster = `${API}/media/poster?url=${encodeURIComponent(remote)}`;
  const oxyServices = { assets: { renderUrl: jest.fn(() => 'https://cdn.oxy.test/thumb') } };

  it('frame-grabs a remote video, unwrapping our proxy, and asks Oxy for its own', () => {
    expect(videoPosterUrl(remote)).toBe(poster);
    expect(videoPosterUrl(proxied)).toBe(poster);
    expect(videoPosterUrl(`${API}/media/proxy`)).toBeUndefined();
    expect(videoPosterUrl(`${API}/videos/1.mp4`)).toBeUndefined();
    expect(videoPosterUrl('file-1', oxyServices as never)).toBe('https://cdn.oxy.test/thumb');
    expect(oxyServices.assets.renderUrl).toHaveBeenCalledWith('file-1', 'thumb');
    expect(videoPosterUrl('file-1')).toBeUndefined();
    expect(videoPosterUrl('')).toBeUndefined();
  });
});
