/**
 * MTN URI Scheme
 *
 * Format: mtn://<oxyUserId>/<collection>/<rkey>
 * Every record in the MTN protocol gets a canonical, parseable URI.
 */

import {
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  MENTION_BOOKMARK_COLLECTION,
} from './lexicons';

const MTN_URI_REGEX = /^mtn:\/\/([^/]+)\/([^/]+(?:\.[^/]+)*)\/([^/]+)$/;

export interface MtnUriParts {
  /** The oxyUserId who owns this record */
  identity: string;
  /** The lexicon NSID (e.g., app.mention.feed.post) */
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
//
// MTN owns post/like/repost/tombstone/bookmark content. The follow/block/profile/
// list lexicons belong to Oxy (the social graph + identity + lists live there),
// so MTN exposes NO URI helpers for them. The collection NSIDs come from the
// MTN lexicon constants so the URI builders cannot drift from the record schemas.

export function createPostUri(oxyUserId: string, postId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: MENTION_POST_COLLECTION, rkey: postId }).toString();
}

export function createLikeUri(oxyUserId: string, likeId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: MENTION_LIKE_COLLECTION, rkey: likeId }).toString();
}

export function createRepostUri(oxyUserId: string, repostId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: MENTION_REPOST_COLLECTION, rkey: repostId }).toString();
}

export function createBookmarkUri(oxyUserId: string, bookmarkId: string): string {
  return new MtnUri({ identity: oxyUserId, collection: MENTION_BOOKMARK_COLLECTION, rkey: bookmarkId }).toString();
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
