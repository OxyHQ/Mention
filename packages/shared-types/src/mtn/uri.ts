/**
 * MTN URI Scheme
 *
 * Format: mtn://<oxyUserId>/<collection>/<rkey>
 * Every record in the MTN protocol gets a canonical, parseable URI.
 */

const MTN_URI_REGEX = /^mtn:\/\/([^/]+)\/([^/]+(?:\.[^/]+)*)\/([^/]+)$/;

export interface MtnUriParts {
  /** The oxyUserId who owns this record */
  identity: string;
  /** The lexicon NSID (e.g., mtn.social.post) */
  collection: string;
  /** The record key (typically the MongoDB _id) */
  rkey: string;
}

export class MtnUri {
  readonly identity: string;
  readonly collection: string;
  readonly rkey: string;

  constructor(parts: MtnUriParts) {
    this.identity = parts.identity;
    this.collection = parts.collection;
    this.rkey = parts.rkey;
  }

  toString(): string {
    return `mtn://${this.identity}/${this.collection}/${this.rkey}`;
  }

  static parse(uri: string): MtnUri {
    const match = uri.match(MTN_URI_REGEX);
    if (!match) {
      throw new Error(`Invalid MTN URI: ${uri}`);
    }
    return new MtnUri({
      identity: match[1],
      collection: match[2],
      rkey: match[3],
    });
  }

  static isValid(uri: string): boolean {
    return MTN_URI_REGEX.test(uri);
  }

  equals(other: MtnUri): boolean {
    return (
      this.identity === other.identity &&
      this.collection === other.collection &&
      this.rkey === other.rkey
    );
  }
}

// --- Helper functions ---

export function createPostUri(oxyUserId: string, postId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: 'mtn.social.post', rkey: postId }).toString();
}

export function createProfileUri(oxyUserId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: 'mtn.social.profile', rkey: 'self' }).toString();
}

export function createLikeUri(oxyUserId: string, likeId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: 'mtn.social.like', rkey: likeId }).toString();
}

export function createRepostUri(oxyUserId: string, repostId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: 'mtn.social.repost', rkey: repostId }).toString();
}

export function createFollowUri(oxyUserId: string, followId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: 'mtn.social.follow', rkey: followId }).toString();
}

export function createFeedGeneratorUri(oxyUserId: string, generatorId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: 'mtn.social.feedGenerator', rkey: generatorId }).toString();
}

export function createListUri(oxyUserId: string, listId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: 'mtn.social.list', rkey: listId }).toString();
}

/**
 * Extract the MongoDB record ID from an MTN URI.
 */
export function mtnUriToRecordId(uri: string): string {
  return MtnUri.parse(uri).rkey;
}

/**
 * Extract the owner's oxyUserId from an MTN URI.
 */
export function mtnUriToIdentity(uri: string): string {
  return MtnUri.parse(uri).identity;
}
