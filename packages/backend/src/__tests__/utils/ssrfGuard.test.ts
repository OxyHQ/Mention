import { describe, it, expect, vi, beforeEach } from 'vitest';

// The SSRF guard now lives ONCE in `@oxyhq/core/server` (Mention's duplicate
// `utils/ssrfGuard.ts` was deleted and every call site converged onto core).
// This suite is Mention's regression proof that the guard Mention consumes from
// core still blocks the private/reserved/metadata ranges and ambiguous hosts.
//
// Mock the DNS resolver so hostname-resolution cases are deterministic and
// never touch the network. Literal-IP and syntax checks below do not hit DNS.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { assertSafePublicUrl, isBlockedIp } from '@oxyhq/core/server';

beforeEach(() => {
  lookupMock.mockReset();
});

// --- isBlockedIp (pure, no DNS) ---------------------------------------------

describe('isBlockedIp', () => {
  it('blocks IPv4 loopback 127.0.0.0/8', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('127.255.255.254')).toBe(true);
  });

  it('blocks cloud metadata 169.254.169.254 (link-local)', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true);
  });

  it('blocks RFC1918 private ranges', () => {
    expect(isBlockedIp('10.0.0.1')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
    expect(isBlockedIp('172.16.0.1')).toBe(true);
    expect(isBlockedIp('172.31.255.255')).toBe(true);
  });

  it('blocks 0.0.0.0/8 and CGNAT 100.64.0.0/10', () => {
    expect(isBlockedIp('0.0.0.0')).toBe(true);
    expect(isBlockedIp('100.64.0.1')).toBe(true);
    expect(isBlockedIp('100.127.255.255')).toBe(true);
  });

  it('blocks multicast and reserved ranges', () => {
    expect(isBlockedIp('224.0.0.1')).toBe(true);
    expect(isBlockedIp('240.0.0.1')).toBe(true);
    expect(isBlockedIp('255.255.255.255')).toBe(true);
  });

  it('allows public IPv4 addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
    expect(isBlockedIp('172.15.0.1')).toBe(false); // just below the private range
    expect(isBlockedIp('172.32.0.1')).toBe(false); // just above the private range
    expect(isBlockedIp('100.63.255.255')).toBe(false); // just below CGNAT
  });

  it('blocks IPv6 loopback, ULA, link-local and unspecified', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('::')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('fd12:3456::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('ff02::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 that wraps a private address', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:192.168.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows public IPv6 (and IPv4-mapped public)', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('fails closed for non-IP input', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

// --- assertSafePublicUrl: syntax / protocol / port (no DNS) -----------------

describe('assertSafePublicUrl — syntax and protocol guards', () => {
  it('rejects an empty url', async () => {
    expect((await assertSafePublicUrl('')).ok).toBe(false);
  });

  it('rejects a malformed url', async () => {
    expect((await assertSafePublicUrl('not a url at all')).ok).toBe(false);
  });

  it('rejects non-http(s) protocols', async () => {
    expect((await assertSafePublicUrl('ftp://example.com/x')).ok).toBe(false);
    expect((await assertSafePublicUrl('file:///etc/passwd')).ok).toBe(false);
    expect((await assertSafePublicUrl('gopher://example.com')).ok).toBe(false);
  });

  it('rejects the literal hostname "localhost"', async () => {
    expect((await assertSafePublicUrl('http://localhost/x')).ok).toBe(false);
  });

  it('rejects non-standard ports', async () => {
    expect((await assertSafePublicUrl('http://8.8.8.8:8080/x')).ok).toBe(false);
    expect((await assertSafePublicUrl('http://8.8.8.8:22/x')).ok).toBe(false);
  });

  it('accepts standard ports explicitly', async () => {
    const r80 = await assertSafePublicUrl('http://8.8.8.8:80/x');
    const r443 = await assertSafePublicUrl('https://8.8.8.8:443/x');
    expect(r80.ok).toBe(true);
    expect(r443.ok).toBe(true);
  });

  it('rejects embedded credentials', async () => {
    expect((await assertSafePublicUrl('http://user:pass@8.8.8.8/x')).ok).toBe(false);
  });

  it('rejects an over-length url', async () => {
    const longUrl = `https://example.com/${'a'.repeat(4000)}`;
    expect((await assertSafePublicUrl(longUrl)).ok).toBe(false);
  });

  it('does not resolve DNS for literal-IP hosts', async () => {
    await assertSafePublicUrl('http://8.8.8.8/x');
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

// --- assertSafePublicUrl: ambiguous numeric hosts (no DNS) ------------------

describe('assertSafePublicUrl — ambiguous numeric hosts', () => {
  // These partial/mixed numeric forms must NEVER reach the OS resolver, where
  // musl (Alpine, prod) and glibc canonicalize inconsistently. They are
  // rejected one of two ways: Node's WHATWG URL parser canonicalizes most of
  // them into a dotted-quad that the literal-IP denylist catches
  // ('literal ip in blocked range'); anything that slips past `isIP()` while
  // remaining purely numeric/hex is caught by the explicit ambiguous-host guard
  // ('ambiguous numeric host'). The security contract is: rejected, no DNS.
  it('rejects partial/mixed numeric forms without resolving DNS', async () => {
    for (const host of ['127.1', '0x7f.1', '0177.0.0.1', '2130706433']) {
      const r = await assertSafePublicUrl(`http://${host}/x`);
      expect(r.ok, host).toBe(false);
      if (!r.ok) {
        expect(['literal ip in blocked range', 'ambiguous numeric host'], host).toContain(r.reason);
      }
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects an all-hex host that bypasses isIP via the guard', async () => {
    // `fa.ce.b0.0c` parses as a URL and is NOT a valid IP literal (isIP === 0),
    // so it would otherwise fall through to the OS resolver — where musl/glibc
    // may map all-hex labels inconsistently. Being composed solely of hex/dot
    // characters, the ambiguous-numeric-host guard must reject it before DNS.
    const r = await assertSafePublicUrl('http://fa.ce.b0.0c/x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous numeric host');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('still resolves genuine hostnames that merely start with digits', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const r = await assertSafePublicUrl('https://3.cdn.example.com/x.jpg');
    expect(r.ok).toBe(true);
    expect(lookupMock).toHaveBeenCalledWith('3.cdn.example.com', { all: true });
  });
});

// --- assertSafePublicUrl: literal IP targets (no DNS) -----------------------

describe('assertSafePublicUrl — literal IP targets', () => {
  it('rejects a literal private IPv4', async () => {
    expect((await assertSafePublicUrl('http://10.0.0.5/x')).ok).toBe(false);
    expect((await assertSafePublicUrl('http://127.0.0.1/x')).ok).toBe(false);
  });

  it('rejects the cloud metadata IP directly', async () => {
    const r = await assertSafePublicUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
  });

  it('rejects a bracketed IPv6 loopback', async () => {
    expect((await assertSafePublicUrl('http://[::1]/x')).ok).toBe(false);
  });

  it('accepts a literal public IPv4 and returns the pinned ip', async () => {
    const r = await assertSafePublicUrl('https://8.8.8.8/x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ip).toBe('8.8.8.8');
      expect(r.family).toBe(4);
    }
  });
});

// --- assertSafePublicUrl: DNS resolution paths (mocked) ---------------------

describe('assertSafePublicUrl — DNS-resolved hostnames', () => {
  it('accepts a hostname that resolves to a public IP and pins it', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const r = await assertSafePublicUrl('https://files.mastodon.social/media/x.mp4');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ip).toBe('93.184.216.34');
      expect(r.family).toBe(4);
    }
    expect(lookupMock).toHaveBeenCalledWith('files.mastodon.social', { all: true });
  });

  it('rejects when the hostname resolves to a private IP (DNS rebind defense)', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const r = await assertSafePublicUrl('https://evil.example.com/x.jpg');
    expect(r.ok).toBe(false);
  });

  it('rejects when ANY of several records is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    const r = await assertSafePublicUrl('https://mixed.example.com/x.jpg');
    expect(r.ok).toBe(false);
  });

  it('rejects when DNS resolution fails', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    const r = await assertSafePublicUrl('https://does-not-exist.example/x.jpg');
    expect(r.ok).toBe(false);
  });

  it('rejects when there are no DNS records', async () => {
    lookupMock.mockResolvedValue([]);
    const r = await assertSafePublicUrl('https://empty.example/x.jpg');
    expect(r.ok).toBe(false);
  });

  it('rejects a hostname resolving to an IPv4-mapped private IPv6', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
    const r = await assertSafePublicUrl('https://sneaky.example/x.jpg');
    expect(r.ok).toBe(false);
  });
});
