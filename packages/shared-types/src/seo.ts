/**
 * The site's own structured data: who publishes it and what it is called.
 *
 * Google reads `WebSite.name` (and `alternateName`) for the site name it shows
 * above every result, and `Organization.logo` for the logo beside it. It is the
 * homepage's, and lives here because two renderers emit it — the backend's
 * initial HTML and the app's head once it has loaded, which replaces the
 * former — and a second copy is how they would come to disagree.
 */
export interface SiteIdentity {
  /** The web origin, without a trailing slash: `https://mention.earth`. */
  origin: string;
  /** The brand name: `Mention`. */
  name: string;
  /**
   * The deployment's own logo (`branding.logoUrl`), when it has one. Without
   * it the site's published icon stands in: Mention's, at a size Google
   * accepts for a logo.
   */
  logoUrl?: string;
}

export function siteStructuredData({ origin, name, logoUrl }: SiteIdentity): Record<string, unknown> {
  const url = `${origin}/`;
  const organizationId = `${origin}/#organization`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organizationId,
        name,
        url,
        logo: logoUrl
          ? { '@type': 'ImageObject', url: logoUrl }
          : { '@type': 'ImageObject', url: `${origin}/icons/mention-512.png`, width: 512, height: 512 },
      },
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        name,
        alternateName: new URL(origin).hostname,
        url,
        publisher: { '@id': organizationId },
      },
    ],
  };
}
