import { LinkMetadata } from '../stores/linksStore';
import { API_CONFIG, getApiOrigin } from '../utils/api';
import { normalizeUrl } from '../utils/composeUtils';

/**
 * Service to fetch link metadata (Open Graph, Twitter Cards, etc.)
 * Thin client wrapper around backend API endpoint
 */
class LinkMetadataService {
  private readonly apiOrigin = getApiOrigin();
  private readonly baseURL = API_CONFIG.baseURL.replace(/\/$/, ''); // Remove trailing slash

  /**
   * Fetch metadata for a URL from backend API
   */
  async fetchMetadata(url: string): Promise<LinkMetadata | null> {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return this.createFallback(url);
    }

    try {
      const response = await fetch(
        `${this.baseURL}/links/metadata?url=${encodeURIComponent(normalizedUrl)}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } }
      );

      if (!response.ok) return this.createFallback(normalizedUrl);

      const data = await response.json();
      if (!data?.success || !data.url) return this.createFallback(normalizedUrl);

      // Construct absolute image URL if present (handles relative paths)
      const imageUrl = data.image && !data.image.startsWith('http')
        ? `${this.apiOrigin}${data.image}`
        : data.image;

      return {
        url: normalizedUrl,
        title: data.title,
        description: data.description,
        image: imageUrl,
        siteName: data.siteName,
        favicon: data.favicon,
        fetchedAt: Date.now(),
      };
    } catch (error) {
      console.debug('[LinkMetadataService] Fetch failed:', error);
      return this.createFallback(normalizedUrl);
    }
  }

  /**
   * Create basic fallback metadata when API is unavailable
   */
  private createFallback(url: string): LinkMetadata {
    try {
      const urlObj = new URL(url);
      return {
        url,
        title: urlObj.hostname,
        siteName: urlObj.hostname.replace('www.', ''),
        fetchedAt: Date.now(),
      };
    } catch {
      return {
        url,
        error: 'Failed to fetch metadata',
        fetchedAt: Date.now(),
      };
    }
  }
}

export const linkMetadataService = new LinkMetadataService();

