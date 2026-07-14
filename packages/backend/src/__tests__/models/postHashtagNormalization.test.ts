import { describe, it, expect } from 'vitest';
import { Post } from '../../models/Post';
import { mergeHashtags, normalizePostHashtags } from '../../utils/textProcessing';
import { PostType, PostVisibility, type StoredPostContent } from '@mention/shared-types';

/**
 * Integration coverage for the centralized hashtag-normalization layer
 * (issues #166 + #146).
 *
 * The normalization is enforced by a `pre('validate')` hook on the Post schema,
 * so EVERY document-based write path (createPost via PostCreationService,
 * createThread, updatePost, replies, boosts, single federated ingest) runs it
 * immediately before persistence. These tests instantiate real Post documents
 * and trigger validation (the same step `save()` runs) without touching a
 * database — proving the hook cleans the post's body and populates `hashtags`
 * regardless of which path set the fields.
 *
 * The body lives in `content.variants[0]` (the primary rendition) — storage is
 * normalized, so there is no second copy of it to clean.
 *
 * The raw federated BATCH path (`Post.collection.insertMany`) bypasses Mongoose
 * middleware and instead calls `normalizePostHashtags` directly; that contract
 * is covered by the final block here and by the pure-function unit tests.
 */

/** The stored content of a single-language post: one primary author rendition. */
function contentWith(text: string): StoredPostContent {
  return { variants: [{ tag: 'en', source: 'author', text }], media: [] };
}

/**
 * Run the document through the same async validation step `save()` performs.
 * `pre('validate')` middleware (where the normalization hook lives) fires on the
 * async `validate()`/`save()` flow — NOT on the synchronous `validateSync()` —
 * so we await `validate()` to exercise the real persistence path. Schema-level
 * validation errors are irrelevant to this suite, so they are swallowed; we only
 * assert on the normalized primary body and the `hashtags` the hook produced.
 */
async function normalizeViaSchema(doc: InstanceType<typeof Post>): Promise<{ content: string; hashtags: string[] }> {
  try {
    await doc.validate();
  } catch {
    // Minimal test documents may miss unrelated required fields; ignore — the
    // normalization hook has already run by the time validation collects errors.
  }
  return { content: doc.content?.variants?.[0]?.text ?? '', hashtags: doc.hashtags ?? [] };
}

describe('Post schema — centralized hashtag normalization hook', () => {
  describe('createPost path (PostCreationService sets content + merged hashtags)', () => {
    it('cleans a trailing 4+ block and keeps the full hashtag set', async () => {
      const text = 'New post about digital communities #startup #social #tech #ai #growth #builders';
      const post = new Post({
        oxyUserId: 'user_1',
        type: PostType.TEXT,
        visibility: PostVisibility.PUBLIC,
        content: contentWith(text),
        // PostCreationService receives hashtags pre-merged by the controller.
        hashtags: mergeHashtags(text, []),
      });

      const result = await normalizeViaSchema(post);
      expect(result.content).toBe('New post about digital communities #startup');
      expect(result.hashtags).toEqual(['startup', 'social', 'tech', 'ai', 'growth', 'builders']);
    });

    it('leaves natural inline hashtags untouched', async () => {
      const text = 'Today we improved #Mention and the feed feels much better.';
      const post = new Post({
        oxyUserId: 'user_1',
        content: contentWith(text),
        hashtags: mergeHashtags(text, []),
      });

      const result = await normalizeViaSchema(post);
      expect(result.content).toBe(text);
      expect(result.hashtags).toEqual(['mention']);
    });

    it('removes a block with no preceding text entirely', async () => {
      const text = '#startup #social #tech #ai #growth';
      const post = new Post({
        oxyUserId: 'user_1',
        content: contentWith(text),
        hashtags: mergeHashtags(text, []),
      });

      const result = await normalizeViaSchema(post);
      expect(result.content).toBe('');
      expect(result.hashtags).toEqual(['startup', 'social', 'tech', 'ai', 'growth']);
    });

    it('preserves user-provided hashtags that never appear in the text', async () => {
      const text = 'A clean post with no inline tags';
      const post = new Post({
        oxyUserId: 'user_1',
        content: contentWith(text),
        hashtags: mergeHashtags(text, ['Climate', 'Policy']),
      });

      const result = await normalizeViaSchema(post);
      expect(result.content).toBe(text);
      expect(result.hashtags).toEqual(['climate', 'policy']);
    });
  });

  describe('createThread / reply / boost paths (direct new Post(...) with merged hashtags)', () => {
    it('keeps exactly 3 consecutive hashtags fully visible', async () => {
      const text = 'Testing categories #design #product #ux';
      const reply = new Post({
        oxyUserId: 'user_2',
        type: PostType.TEXT,
        content: contentWith(text),
        parentPostId: 'parent_1',
        threadId: 'parent_1',
        hashtags: mergeHashtags(text, []),
      });

      const result = await normalizeViaSchema(reply);
      expect(result.content).toBe(text);
      expect(result.hashtags).toEqual(['design', 'product', 'ux']);
    });

    it('cleans a mixed post: natural inline tag + trailing spam block', async () => {
      const text = 'I like how #Mention is evolving for public conversations. #social #network #startup #tech #ai #growth';
      const boost = new Post({
        oxyUserId: 'user_3',
        type: PostType.BOOST,
        boostOf: 'orig_1',
        content: contentWith(text),
        hashtags: mergeHashtags(text, []),
      });

      const result = await normalizeViaSchema(boost);
      expect(result.content).toBe('I like how #Mention is evolving for public conversations. #social');
      expect(result.hashtags).toEqual(['mention', 'social', 'network', 'startup', 'tech', 'ai', 'growth']);
    });
  });

  describe('updatePost path (rewrite the primary rendition then re-validate)', () => {
    it('re-cleans the body and re-derives hashtags when the text changes', async () => {
      const post = new Post({
        oxyUserId: 'user_4',
        content: contentWith('Original clean post #hello'),
        hashtags: mergeHashtags('Original clean post #hello', []),
      });
      await normalizeViaSchema(post);
      expect(post.hashtags).toEqual(['hello']);

      // Simulate an edit that introduces a spammy block. The edit path rewrites the
      // primary RENDITION — there is no separate body to keep in sync.
      const newText = 'Edited post about launch #news #launch #product #growth #ai';
      post.content.variants = [{ tag: 'en', source: 'author', text: newText }];
      post.markModified('content.variants');
      post.hashtags = mergeHashtags(newText, post.hashtags);

      const result = await normalizeViaSchema(post);
      expect(result.content).toBe('Edited post about launch #news');
      expect(result.hashtags).toEqual(['hello', 'news', 'launch', 'product', 'growth', 'ai']);
    });

    it('is idempotent — saving again without text changes does not re-strip', async () => {
      const text = 'Launch news #news #launch #product #growth #ai';
      const post = new Post({
        oxyUserId: 'user_4',
        content: contentWith(text),
        hashtags: mergeHashtags(text, []),
      });
      const first = await normalizeViaSchema(post);
      expect(first.content).toBe('Launch news #news');

      // A subsequent unrelated save (e.g. stats bump) must not re-process the body.
      post.isNew = false;
      const second = await normalizeViaSchema(post);
      expect(second.content).toBe('Launch news #news');
      expect(second.hashtags).toEqual(['news', 'launch', 'product', 'growth', 'ai']);
    });
  });

  describe('federated batch path (normalizePostHashtags called directly)', () => {
    it('produces the same cleaned content + hashtags as the schema hook', async () => {
      const text = 'Federated note about communities #startup #social #tech #ai #growth #builders';
      const apTags = ['Startup', 'Social', 'Tech', 'Ai', 'Growth', 'Builders'];
      const direct = normalizePostHashtags(text, apTags);

      const post = new Post({
        oxyUserId: 'fed_user',
        content: contentWith(text),
        hashtags: mergeHashtags(text, apTags),
      });
      const viaHook = await normalizeViaSchema(post);

      expect(direct.content).toBe(viaHook.content);
      expect(direct.hashtags).toEqual(viaHook.hashtags);
      expect(direct.content).toBe('Federated note about communities #startup');
      expect(direct.hashtags).toEqual(['startup', 'social', 'tech', 'ai', 'growth', 'builders']);
    });

    it('merges AP tag-array tags not present inline in the note body', async () => {
      const text = 'A federated note with no inline tags';
      const apTags = ['Fediverse', 'ActivityPub'];
      const direct = normalizePostHashtags(text, apTags);
      expect(direct.content).toBe(text);
      expect(direct.hashtags).toEqual(['fediverse', 'activitypub']);
    });
  });
});
