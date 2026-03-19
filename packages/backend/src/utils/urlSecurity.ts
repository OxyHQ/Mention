import { URL } from 'url';

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
    /^::ffff:0:127\./, // IPv4-mapped localhost
  ];

  // Check IPv4
  for (const range of privateIPv4Ranges) {
    if (range.test(ip)) {
      return true;
    }
  }

  // Check IPv6
  for (const range of privateIPv6Ranges) {
    if (range.test(ip)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate URL is safe to fetch (prevents SSRF attacks)
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

    // Resolve hostname to IP to check for private IPs (async DNS lookup would be needed)
    // For now, we rely on hostname checks above

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Sanitize HTML content to prevent XSS
 * Removes script tags and dangerous attributes
 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  // Remove script tags and their content
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  
  // Remove event handlers (onclick, onerror, etc.)
  html = html.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '');
  
  // Remove javascript: protocol in links
  html = html.replace(/javascript:/gi, '');
  
  // Remove data: URIs that could be dangerous
  html = html.replace(/data:text\/html/gi, '');
  
  return html;
}

/**
 * Sanitize text content to prevent XSS
 * Escapes HTML entities
 */
export function sanitizeText(text: string | null | undefined): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  // Decode HTML entities first
  const decoded = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');

  // Then escape dangerous characters
  return decoded
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Validate URL length (prevent DoS)
 */
export function validateUrlLength(url: string, maxLength: number = 2048): boolean {
  return url.length <= maxLength;
}

