import { LinkMetadata } from '../stores/linksStore';
import { API_CONFIG, getApiOrigin } from '../utils/api';
import { normalizeUrl } from '../utils/composeUtils';

/**
 * Construct absolute image URL from relative path
 */
function constructImageUrl(imageUrl: string, apiOrigin: string): string {
  if (!imageUrl) return imageUrl;
  
  // Already absolute
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    return imageUrl;
  }
  
  // Relative path - prepend API origin
  return `${apiOrigin}${imageUrl}`;
}

/**
 * Service to fetch link metadata (Open Graph, Twitter Cards, etc.)
 * Thin client wrapper around backend API endpoint
 */
class LinkMetadataService {
  private readonly apiOrigin = getApiOrigin();

  /**
   * Fetch metadata for a URL from backend API
   */
  async fetchMetadata(url: string): Promise<LinkMetadata | null> {
    try {
      const normalizedUrl = normalizeUrl(url);
      if (!normalizedUrl) {
        throw new Error('Invalid URL');
      }

      // Fetch from backend API
      const baseURL = API_CONFIG.baseURL.endsWith('/') 
        ? API_CONFIG.baseURL.slice(0, -1) 
        : API_CONFIG.baseURL;
      
      const response = await fetch(
        `${baseURL}/links/metadata?url=${encodeURIComponent(normalizedUrl)}`,
        {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json();
      if (!data?.success || !data.url) {
        return this.createFallbackMetadata(normalizedUrl);
      }

      // Construct absolute image URL if present
      const imageUrl = data.image 
        ? constructImageUrl(data.image, this.apiOrigin)
        : undefined;

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
      console.debug('[LinkMetadataService] Backend fetch failed:', error);
      return this.createFallbackMetadata(url);
    }
  }

  /**
   * Create basic fallback metadata when API is unavailable
   */
  private createFallbackMetadata(url: string): LinkMetadata | null {
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

