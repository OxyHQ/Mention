import { URL } from 'url';
import dns from 'dns';
import sanitizeHtmlLib from 'sanitize-html';

/**
 * Security utilities for URL validation and sanitization
 */

/**
 * Check if an IP address is private/internal
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  const privateIPv4Ranges = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^127\./,
    /^169\.254\./, // Link-local
    /^0\.0\.0\.0$/,
  ];

  // IPv6 private ranges
  const privateIPv6Ranges = [
    /^::1$/, // localhost
    /^fc00:/, // Unique local address
    /^fe80:/, // Link-local
    /^::ffff:(0:)?127\./, // IPv4-mapped localhost
    /^::ffff:(0:)?10\./, // IPv4-mapped private
    /^::ffff:(0:)?192\.168\./, // IPv4-mapped private
    /^::ffff:(0:)?172\.(1[6-9]|2[0-9]|3[0-1])\./, // IPv4-mapped private
  ];

  for (const range of privateIPv4Ranges) {
    if (range.test(ip)) {
      return true;
    }
  }

  for (const range of privateIPv6Ranges) {
    if (range.test(ip)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate URL is safe to fetch (prevents SSRF attacks).
 * Performs hostname checks synchronously. Use validateUrlSecurityWithDNS
 * for full protection including DNS resolution.
 */
export function validateUrlSecurity(url: string): { valid: boolean; error?: string } {
  try {
    const urlObj = new URL(url);

    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
    }

    // Block localhost and local domains
    const hostname = urlObj.hostname.toLowerCase();
    const blockedHosts = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '[::1]',
    ];

    if (blockedHosts.includes(hostname)) {
      return { valid: false, error: 'Localhost URLs are not allowed' };
    }

    // Check for private IP addresses
    if (isPrivateIP(hostname)) {
      return { valid: false, error: 'Private IP addresses are not allowed' };
    }

    // Block common internal domain patterns
    const blockedPatterns = [
      /^.*\.local$/,
      /^.*\.internal$/,
      /^.*\.lan$/,
      /^192\.168\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    ];

    for (const pattern of blockedPatterns) {
      if (pattern.test(hostname)) {
        return { valid: false, error: 'Internal domains are not allowed' };
      }
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Validate URL security with DNS resolution to prevent SSRF via DNS rebinding.
 * Resolves the hostname to IP addresses and checks each one against private ranges.
 * This catches domains like localtest.me that resolve to 127.0.0.1.
 */
export async function validateUrlSecurityWithDNS(url: string): Promise<{ valid: boolean; error?: string }> {
  // First run synchronous checks
  const syncResult = validateUrlSecurity(url);
  if (!syncResult.valid) {
    return syncResult;
  }

  // Then resolve DNS and check resolved IPs
  const urlObj = new URL(url);
  const hostname = urlObj.hostname.toLowerCase();

  // Skip DNS check for raw IP addresses (already checked above)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return { valid: true };
  }

  try {
    // Resolve both IPv4 and IPv6 addresses
    const [ipv4Addresses, ipv6Addresses] = await Promise.allSettled([
      dns.promises.resolve4(hostname),
      dns.promises.resolve6(hostname),
    ]);

    const allIPs: string[] = [];
    if (ipv4Addresses.status === 'fulfilled') {
      allIPs.push(...ipv4Addresses.value);
    }
    if (ipv6Addresses.status === 'fulfilled') {
      allIPs.push(...ipv6Addresses.value);
    }

    // If we couldn't resolve any IPs, allow the request (DNS might be flaky)
    // The actual fetch will fail if the host is truly unreachable
    if (allIPs.length === 0) {
      return { valid: true };
    }

    // Check each resolved IP against private ranges
    for (const ip of allIPs) {
      if (isPrivateIP(ip)) {
        return { valid: false, error: 'URL resolves to a private IP address' };
      }
    }

    return { valid: true };
  } catch {
    // DNS resolution failed — allow the request, the fetch will fail naturally
    return { valid: true };
  }
}

/**
 * Sanitize HTML content to prevent XSS.
 * Uses sanitize-html library for robust protection against bypass techniques.
 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  return sanitizeHtmlLib(html, {
    allowedTags: sanitizeHtmlLib.defaults.allowedTags.concat(['img']),
    allowedAttributes: {
      ...sanitizeHtmlLib.defaults.allowedAttributes,
      img: ['src', 'alt', 'width', 'height'],
      a: ['href', 'title', 'rel', 'target'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'discard',
  });
}

/**
 * Sanitize text content to prevent XSS.
 * Escapes HTML entities.
 */
export function sanitizeText(text: string | null | undefined): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate URL length (prevent DoS)
 */
export function validateUrlLength(url: string, maxLength: number = 2048): boolean {
  return url.length <= maxLength;
}
