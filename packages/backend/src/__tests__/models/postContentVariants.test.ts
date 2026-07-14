import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { Post } from '../../models/Post';
import { PostVisibility } from '@mention/shared-types';

/**
 * Storage is NORMALIZED: `content.variants[]` is the only home for a post's text
 * and `variants[0]` is the primary. There is no `content.text` to keep in sync —
 * which is the point: a mirror would drift on the one write path that skips
 * Mongoose middleware (the federated outbox backfill's `collection.insertMany`).
 *
 * What the schema DOES enforce, on every document write, is that `variants[0]` is
 * really the primary (the author's renditions ahead of the machine translations)
 * and that no author-written rendition renders a spammy hashtag block, whichever
 * language a reader is served.
 *
 * These instantiate real Post documents (no DB) and `await post.validate()`, which
 * is what runs the `pre('validate')` hook (`validateSync` skips middleware).
 */

describe('Post schema — content variants', () => {
  it('stores the renditions with no separate body — variants[0] IS the primary', async () => {
    const post = new Post({
      oxyUserId: 'user_1',
      visibility: PostVisibility.PUBLIC,
      content: {
        variants: [
          { tag: 'es-ES', source: 'author', text: 'Hola mundo' },
          { tag: 'en-US', source: 'author', text: 'Hello world' },
        ],
      },
    });

    await post.validate();

    expect(post.content.variants?.[0]).toMatchObject({ tag: 'es-ES', text: 'Hola mundo' });
    // Nothing keeps a second copy of the body.
    expect(post.toObject().content).not.toHaveProperty('text');
  });

  it('keeps the author’s renditions ahead of the machine translations', async () => {
    const post = new Post({
      oxyUserId: 'user_2',
      content: {
        variants: [
          { tag: 'de-DE', source: 'machine', text: 'Hallo Welt' },
          { tag: 'es-ES', source: 'author', text: 'Hola mundo' },
          { tag: 'en-US', source: 'author', text: 'Hello world' },
        ],
      },
    });

    await post.validate();

    expect(post.content.variants?.map((variant) => variant.tag)).toEqual(['es-ES', 'en-US', 'de-DE']);
    expect(post.content.variants?.[0].source).toBe('author');
  });

  it('accepts an UNTAGGED primary — a body whose language nothing could resolve', async () => {
    // Minting a tag from a detector's best guess would federate that guess as a
    // declaration, so an unresolvable language stays absent instead.
    const post = new Post({
      oxyUserId: 'user_3',
      content: { variants: [{ source: 'author', text: 'ok' }] },
    });

    await post.validate();

    expect(post.content.variants?.[0].tag).toBeUndefined();
    expect(post.content.variants?.[0].text).toBe('ok');
  });

  it('leaves a boost with no rendition at all — it has no body', async () => {
    const post = new Post({
      oxyUserId: 'user_4',
      boostOf: 'post_1',
      content: {},
    });

    await post.validate();

    expect(post.content.variants).toBeUndefined();
  });

  it('cleans the spammy hashtag block out of EVERY author rendition, not just the primary', async () => {
    const post = new Post({
      oxyUserId: 'user_5',
      content: {
        variants: [
          { tag: 'es-ES', source: 'author', text: 'Mira esto #a #b #c #d #e' },
          { tag: 'en-US', source: 'author', text: 'Look at this #a #b #c #d #e' },
        ],
      },
    });

    await post.validate();

    expect(post.content.variants?.[0].text).toBe('Mira esto #a');
    expect(post.content.variants?.[1].text).toBe('Look at this #a');
    // The canonical hashtag list still comes from the PRIMARY body.
    expect(post.hashtags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('re-cleans the primary when an edit rewrites it', async () => {
    // `hydrate` models the document the edit path works on: one LOADED from Mongo,
    // with no modified paths.
    const post = Post.hydrate({
      _id: new mongoose.Types.ObjectId(),
      oxyUserId: 'user_6',
      content: { variants: [{ tag: 'es-ES', source: 'author', text: 'Hola mundo' }] },
    });

    post.content.variants = [{ tag: 'es-ES', source: 'author', text: 'Editado #a #b #c #d #e' }];
    post.markModified('content.variants');
    await post.validate();

    expect(post.content.variants?.[0].text).toBe('Editado #a');
    expect(post.hashtags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
