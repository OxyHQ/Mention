import { LinkMetadata } from '../stores/linksStore';
import { publicClient, getApiOrigin } from '../utils/api';
import { normalizeUrl } from '../utils/composeUtils';

/**
 * Service to fetch link metadata (Open Graph, Twitter Cards, etc.)
 * Thin client wrapper around backend API endpoint
 */
class LinkMetadataService {
  /**
   * Fetch metadata for a URL from backend API
   */
  async fetchMetadata(url: string): Promise<LinkMetadata | null> {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return this.createFallback(url);
    }

    try {
      const response = await publicClient.get('/links/metadata', {
        params: { url: normalizedUrl },
      });

      const data = response.data;
      if (!data?.success || !data.url) return this.createFallback(normalizedUrl);

      // Construct absolute image URL if present (handles relative paths)
      const apiOrigin = getApiOrigin();
      const imageUrl = data.image && !data.image.startsWith('http')
        ? `${apiOrigin}${data.image}`
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
    } catch {
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

