import { isHostOf } from '../isHostOf';

describe('isHostOf', () => {
  it('accepts the domain itself', () => {
    expect(isHostOf('spotify.com', 'spotify.com')).toBe(true);
  });

  it('accepts a subdomain', () => {
    expect(isHostOf('open.spotify.com', 'spotify.com')).toBe(true);
    expect(isHostOf('m.youtube.com', 'youtube.com')).toBe(true);
  });

  it('rejects a lookalike that only shares the suffix', () => {
    expect(isHostOf('notspotify.com', 'spotify.com')).toBe(false);
    expect(isHostOf('evil-syra.fm', 'syra.fm')).toBe(false);
  });

  it('rejects the domain appearing anywhere but the end', () => {
    expect(isHostOf('spotify.com.attacker.net', 'spotify.com')).toBe(false);
  });
});
