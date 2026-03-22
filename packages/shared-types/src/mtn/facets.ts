/**
 * MTN Rich Text Facets
 *
 * Position-aware annotations for post text content.
 * Inspired by AT Protocol's facet system with byte-range indexing.
 * Replaces loose mentions[] and hashtags[] arrays.
 */

export interface ByteSlice {
  /** Start byte index (inclusive) */
  byteStart: number;
  /** End byte index (exclusive) */
  byteEnd: number;
}

// --- Feature types ---

export interface MentionFeature {
  type: 'mention';
  /** The oxyUserId of the mentioned user */
  did: string;
}

export interface LinkFeature {
  type: 'link';
  /** The URL target */
  uri: string;
}

export interface HashtagFeature {
  type: 'hashtag';
  /** The hashtag text (without #) */
  tag: string;
}

export interface TagFeature {
  type: 'tag';
  /** Arbitrary tag value (for categorization) */
  tag: string;
}

export type FacetFeature = MentionFeature | LinkFeature | HashtagFeature | TagFeature;

export interface Facet {
  index: ByteSlice;
  features: FacetFeature[];
}

// --- Helpers ---

/**
 * Extract all mentions from facets.
 */
export function extractMentions(facets: Facet[]): string[] {
  return facets
    .flatMap((f) => f.features)
    .filter((feat): feat is MentionFeature => feat.type === 'mention')
    .map((feat) => feat.did);
}

/**
 * Extract all hashtags from facets.
 */
export function extractHashtags(facets: Facet[]): string[] {
  return facets
    .flatMap((f) => f.features)
    .filter((feat): feat is HashtagFeature => feat.type === 'hashtag')
    .map((feat) => feat.tag);
}

/**
 * Extract all links from facets.
 */
export function extractLinks(facets: Facet[]): string[] {
  return facets
    .flatMap((f) => f.features)
    .filter((feat): feat is LinkFeature => feat.type === 'link')
    .map((feat) => feat.uri);
}

/**
 * Validate facet byte ranges don't overlap and are within text bounds.
 */
export function validateFacets(facets: Facet[], textByteLength: number): string[] {
  const errors: string[] = [];

  for (let i = 0; i < facets.length; i++) {
    const facet = facets[i];
    if (facet.index.byteStart < 0) {
      errors.push(`Facet ${i}: byteStart must be >= 0`);
    }
    if (facet.index.byteEnd > textByteLength) {
      errors.push(`Facet ${i}: byteEnd (${facet.index.byteEnd}) exceeds text length (${textByteLength})`);
    }
    if (facet.index.byteStart >= facet.index.byteEnd) {
      errors.push(`Facet ${i}: byteStart must be < byteEnd`);
    }
    if (facet.features.length === 0) {
      errors.push(`Facet ${i}: must have at least one feature`);
    }
  }

  // Check for overlaps
  const sorted = [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].index.byteStart < sorted[i - 1].index.byteEnd) {
      errors.push(`Facets ${i - 1} and ${i} overlap`);
    }
  }

  return errors;
}
