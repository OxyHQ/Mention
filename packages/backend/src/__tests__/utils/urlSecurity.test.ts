import { describe, it, expect } from 'vitest';
import {
  validateUrlSecurity,
  sanitizeHtml,
  sanitizeText,
} from '../../utils/urlSecurity';

// --- validateUrlSecurity (synchronous) --------------------------------------

describe('validateUrlSecurity', () => {
  describe('blocked URLs', () => {
    it('blocks localhost by hostname', () => {
      const result = validateUrlSecurity('http://localhost/path');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('blocks 127.0.0.1', () => {
      expect(validateUrlSecurity('http://127.0.0.1/').valid).toBe(false);
    });

    it('blocks 0.0.0.0', () => {
      expect(validateUrlSecurity('http://0.0.0.0/').valid).toBe(false);
    });

    it('blocks IPv6 loopback [::1]', () => {
      expect(validateUrlSecurity('http://[::1]/').valid).toBe(false);
    });

    it('blocks 10.x.x.x private range', () => {
      expect(validateUrlSecurity('http://10.0.0.1/').valid).toBe(false);
    });

    it('blocks 192.168.x.x private range', () => {
      expect(validateUrlSecurity('http://192.168.1.1/').valid).toBe(false);
    });

    it('blocks 172.16.x.x through 172.31.x.x private range', () => {
      expect(validateUrlSecurity('http://172.16.0.1/').valid).toBe(false);
      expect(validateUrlSecurity('http://172.31.255.255/').valid).toBe(false);
    });

    it('blocks .local TLD (mDNS names)', () => {
      expect(validateUrlSecurity('http://myserver.local/').valid).toBe(false);
    });

    it('blocks .internal TLD', () => {
      expect(validateUrlSecurity('http://db.internal/').valid).toBe(false);
    });

    it('blocks .lan TLD', () => {
      expect(validateUrlSecurity('http://router.lan/').valid).toBe(false);
    });

    it('blocks non-HTTP/HTTPS protocols', () => {
      expect(validateUrlSecurity('ftp://example.com/file').valid).toBe(false);
      expect(validateUrlSecurity('file:///etc/passwd').valid).toBe(false);
    });

    it('returns valid:false for a completely malformed URL', () => {
      expect(validateUrlSecurity('not a url at all').valid).toBe(false);
    });
  });

  describe('allowed URLs', () => {
    it('allows a normal HTTPS URL', () => {
      expect(validateUrlSecurity('https://example.com/').valid).toBe(true);
    });

    it('allows a normal HTTP URL', () => {
      expect(validateUrlSecurity('http://example.com/path?q=1').valid).toBe(true);
    });

    it('allows a public IP address', () => {
      // 8.8.8.8 is Google DNS — a valid public IP
      expect(validateUrlSecurity('http://8.8.8.8/').valid).toBe(true);
    });

    it('allows subdomains', () => {
      expect(validateUrlSecurity('https://api.mention.earth/v1').valid).toBe(true);
    });

    // 172.15.x.x is NOT in the private range (only 172.16-31 are)
    it('allows 172.15.x.x (outside the private range)', () => {
      expect(validateUrlSecurity('http://172.15.0.1/').valid).toBe(true);
    });
  });

  describe('error messages', () => {
    it('reports why localhost is blocked', () => {
      const result = validateUrlSecurity('http://localhost/');
      expect(result.error).toMatch(/localhost/i);
    });

    it('reports why a private IP is blocked', () => {
      const result = validateUrlSecurity('http://192.168.0.1/');
      expect(result.error).toMatch(/private/i);
    });
  });
});

// --- sanitizeHtml -----------------------------------------------------------

describe('sanitizeHtml', () => {
  it('returns empty string for null/undefined input', () => {
    expect(sanitizeHtml(null as unknown as string)).toBe('');
    expect(sanitizeHtml(undefined as unknown as string)).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeHtml(123 as unknown as string)).toBe('');
  });

  it('strips <script> tags and their content', () => {
    const input = '<p>Hello</p><script>alert("xss")</script>';
    const output = sanitizeHtml(input);
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('alert');
    expect(output).toContain('Hello');
  });

  it('strips onclick and other event attributes', () => {
    const input = '<a href="https://example.com" onclick="steal()">click</a>';
    const output = sanitizeHtml(input);
    expect(output).not.toContain('onclick');
    expect(output).toContain('href');
  });

  it('strips javascript: href values', () => {
    const input = '<a href="javascript:alert(1)">click</a>';
    const output = sanitizeHtml(input);
    expect(output).not.toContain('javascript:');
  });

  it('allows safe tags like <b>, <i>, <p>', () => {
    const input = '<p><b>Bold</b> and <i>italic</i></p>';
    const output = sanitizeHtml(input);
    expect(output).toContain('<b>Bold</b>');
    expect(output).toContain('<i>italic</i>');
  });

  it('allows <img> with safe attributes', () => {
    const input = '<img src="https://example.com/img.jpg" alt="test">';
    const output = sanitizeHtml(input);
    expect(output).toContain('<img');
    expect(output).toContain('src=');
  });

  it('strips <iframe> tags', () => {
    const input = '<p>text</p><iframe src="https://evil.com"></iframe>';
    const output = sanitizeHtml(input);
    expect(output).not.toContain('<iframe');
  });

  it('passes through plain text unchanged', () => {
    const input = 'Just plain text without any HTML.';
    expect(sanitizeHtml(input)).toBe(input);
  });
});

// --- sanitizeText -----------------------------------------------------------

describe('sanitizeText', () => {
  it('returns empty string for null input', () => {
    expect(sanitizeText(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(sanitizeText(undefined)).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(sanitizeText('')).toBe('');
  });

  it('escapes < and > characters', () => {
    expect(sanitizeText('<script>')).toBe('&lt;script&gt;');
  });

  it('passes through & character', () => {
    expect(sanitizeText('a & b')).toBe('a & b');
  });

  it('escapes double quotes', () => {
    expect(sanitizeText('"quoted"')).toBe('&quot;quoted&quot;');
  });

  it('escapes single quotes', () => {
    expect(sanitizeText("it's")).toBe('it&#39;s');
  });

  it('escapes a full XSS payload', () => {
    const payload = '<img src=x onerror="alert(\'xss\')">';
    const sanitized = sanitizeText(payload);
    expect(sanitized).not.toContain('<');
    expect(sanitized).not.toContain('>');
    expect(sanitized).not.toContain('"');
  });

  it('leaves safe text unchanged', () => {
    const safe = 'Hello world 123';
    expect(sanitizeText(safe)).toBe(safe);
  });
});
