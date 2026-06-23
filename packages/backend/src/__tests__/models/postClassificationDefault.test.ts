import { describe, it, expect } from 'vitest';
import { Post } from '../../models/Post';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * Verifies the Post schema seeds a `pending` classification subdoc on creation.
 *
 * Because the default lives on the schema (not in any controller), EVERY
 * document-based creation path — composer/API via PostCreationService,
 * createThread, replies, single federated ingest, MCP — yields a post the
 * async classification batch job will pick up, with zero per-path code. These
 * tests instantiate real Post documents (no DB) and assert the default subdoc.
 *
 * The raw federated BATCH path (`Post.collection.insertMany`) bypasses Mongoose
 * defaults and is covered separately by FederationService setting the subdoc
 * explicitly.
 */

describe('Post schema — postClassification default', () => {
  it('new posts default to a pending classification subdoc', () => {
    const post = new Post({
      oxyUserId: 'user_1',
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      content: { text: 'A brand new post', media: [] },
    });

    expect(post.postClassification).toBeDefined();
    expect(post.postClassification?.status).toBe('pending');
    expect(post.postClassification?.classifiedAt).toBeUndefined();
  });

  it('initializes neutral score and metadata defaults', () => {
    const post = new Post({
      oxyUserId: 'user_2',
      content: { text: 'Another post', media: [] },
    });

    const classification = post.postClassification;
    expect(classification?.topics).toEqual([]);
    expect(classification?.sentiment).toBe('neutral');
    expect(classification?.intent).toBe('other');
    expect(classification?.confidence).toBe(0);
    const scores = classification?.scores;
    expect(scores?.toxicity).toBe(0);
    expect(scores?.constructiveness).toBe(0);
    expect(scores?.spam).toBe(0);
    expect(scores?.quality).toBe(0);
    expect(scores?.controversy).toBe(0);
    expect(scores?.negativity).toBe(0);
  });

  it('classification is independent of hashtags (separate fields)', () => {
    const post = new Post({
      oxyUserId: 'user_3',
      content: { text: 'Posting about #ai and #startups', media: [] },
      hashtags: ['ai', 'startups'],
    });

    // Hashtags are the user-written tokens; classification is its own subdoc and
    // is not derived from or stored alongside the hashtags array.
    expect(post.hashtags).toContain('ai');
    expect(post.postClassification?.status).toBe('pending');
    expect(post.postClassification?.topics).toEqual([]);
  });

  it('rejects scores outside the 0..1 range via schema validation', async () => {
    const post = new Post({
      oxyUserId: 'user_4',
      content: { text: 'Out of range scores', media: [] },
    });
    if (post.postClassification?.scores) {
      post.postClassification.scores.toxicity = 5;
    }

    const error = post.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors['postClassification.scores.toxicity']).toBeDefined();
  });

  it('accepts a valid classified subdoc', () => {
    const post = new Post({
      oxyUserId: 'user_5',
      content: { text: 'Classified post', media: [] },
      postClassification: {
        topics: ['feed', 'product_feedback'],
        sentiment: 'mixed',
        intent: 'feedback',
        scores: { toxicity: 0, constructiveness: 0.85, spam: 0, quality: 0.8, controversy: 0.1, negativity: 0.45 },
        confidence: 0.88,
        status: 'classified',
        classifiedAt: new Date(),
      },
    });

    const error = post.validateSync();
    expect(error?.errors['postClassification.sentiment']).toBeUndefined();
    expect(post.postClassification?.status).toBe('classified');
    expect(post.postClassification?.scores?.constructiveness).toBe(0.85);
  });
});
