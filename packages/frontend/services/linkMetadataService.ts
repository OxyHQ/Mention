import { LinkMetadata } from '../stores/linksStore';
import { API_CONFIG } from '../utils/api';

/**
 * Service to fetch link metadata (Open Graph, Twitter Cards, etc.)
 * Similar to how Twitter fetches link previews
 */
class LinkMetadataService {
  /**
   * Fetch metadata for a URL
   * Uses a backend endpoint if available, otherwise falls back to client-side parsing
   */
  async fetchMetadata(url: string): Promise<LinkMetadata | null> {
    try {
      // Normalize URL
      const normalizedUrl = this.normalizeUrl(url);
      if (!normalizedUrl) {
        throw new Error('Invalid URL');
      }

      // Fetch from backend API
      try {
        // API_CONFIG.baseURL already includes /api, so we just need /links/metadata
        const baseURL = API_CONFIG.baseURL.endsWith('/') 
          ? API_CONFIG.baseURL.slice(0, -1) 
          : API_CONFIG.baseURL;
        const response = await fetch(`${baseURL}/links/metadata?url=${encodeURIComponent(normalizedUrl)}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data && data.success && data.url) {
            // Handle image URL - could be cached (relative) or external (absolute)
            let imageUrl = data.image;
            if (imageUrl) {
              if (imageUrl.startsWith('/api/links/images/')) {
                // Cached image URL - baseURL already includes /api, so remove /api prefix
                // imageUrl: /api/links/images/...
                // baseURL: http://localhost:3000/api
                // Result: http://localhost:3000/api/links/images/...
                const imagePath = imageUrl.substring(4); // Remove leading '/api'
                imageUrl = `${baseURL}${imagePath}`;
              } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
                // External image URL - use as-is
                // Note: External images may have CORS issues, but cached images won't
                imageUrl = imageUrl;
              } else if (imageUrl.startsWith('/')) {
                // Relative URL - make absolute
                const imagePath = imageUrl.startsWith('/api/') ? imageUrl.substring(4) : imageUrl;
                imageUrl = `${baseURL}${imagePath}`;
              }
            }
            
            return {
              url: normalizedUrl,
              title: data.title,
              description: data.description,
              image: imageUrl,
              siteName: data.siteName,
              favicon: data.favicon,
              fetchedAt: Date.now(),
            };
          }
        }
      } catch (apiError) {
        // Backend endpoint might not be available, fall through to client-side parsing
        console.debug('[LinkMetadataService] Backend endpoint error:', apiError);
      }

      // Fallback: Client-side metadata fetching using a proxy or direct fetch
      // Note: CORS may block direct fetches, so we use a simple approach
      return await this.fetchMetadataClientSide(normalizedUrl);
    } catch (error) {
      console.error('[LinkMetadataService] Error fetching metadata:', error);
      return {
        url,
        error: error instanceof Error ? error.message : 'Failed to fetch metadata',
        fetchedAt: Date.now(),
      };
    }
  }

  /**
   * Client-side metadata fetching
   * This is a simplified version - for production, you'd want a backend endpoint
   */
  private async fetchMetadataClientSide(url: string): Promise<LinkMetadata | null> {
    try {
      // For React Native, we can't directly parse HTML
      // This would require a backend endpoint or a service like LinkPreview API
      // For now, return basic metadata
      const urlObj = new URL(url);
      return {
        url,
        title: urlObj.hostname,
        siteName: urlObj.hostname.replace('www.', ''),
        fetchedAt: Date.now(),
      };
    } catch (error) {
      console.error('[LinkMetadataService] Client-side fetch failed:', error);
      return null;
    }
  }

  /**
   * Normalize URL
   */
  private normalizeUrl(url: string): string | null {
    if (!url || typeof url !== 'string') return null;
    let normalized = url.trim();
    if (!normalized) return null;

    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }

    try {
      const parsed = new URL(normalized);
      return parsed.toString();
    } catch {
      return null;
    }
  }
}

export const linkMetadataService = new LinkMetadataService();

