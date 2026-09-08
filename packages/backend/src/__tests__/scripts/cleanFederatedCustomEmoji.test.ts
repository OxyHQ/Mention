import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres } from '../../db/postgres';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { planHistoricalEmojiCleanup } from '../../scripts/cleanFederatedCustomEmoji';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

const scope = postScope('clean-federated-custom-emoji');
const author = scope.user('author');

async function remotePost(content: PostRecordInput['content']) {
  return seedPost(scope, {
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    federation: {
      activityId: 'https://remote.example/notes/one',
      actorUri: 'https://remote.example/users/author',
    },
    content,
  });
}

beforeAll(connectPostgres);
afterEach(() => clearPostScope(scope));
afterAll(closePostgres);

describe('planHistoricalEmojiCleanup', () => {
  it('cleans verified custom emoji while retaining the author prose', async () => {
    const post = await remotePost({
      variants: [{ source: 'author', text: '\u200B:remote:\u200B Hola 🔥 :literal:', tag: 'es' }],
    });
    expect(planHistoricalEmojiCleanup(post, [':remote:'])).toEqual({
      kind: 'update',
      variants: [{ source: 'author', text: 'Hola 🔥 :literal:', tag: 'es' }],
      spoilerText: undefined,
    });
  });

  it('deletes a verified custom-emoji-only post with no rescuing content', async () => {
    const post = await remotePost({ variants: [{ source: 'author', text: ':remote:' }] });
    expect(planHistoricalEmojiCleanup(post, [':remote:'])).toEqual({ kind: 'delete' });
  });

  it('keeps a media post after its custom-emoji-only caption is removed', async () => {
    const post = await remotePost({
      variants: [{ source: 'author', text: ':remote:' }],
      media: [{ id: 'image-one', type: 'image' }],
    });
    expect(planHistoricalEmojiCleanup(post, [':remote:'])).toEqual({
      kind: 'update',
      variants: [],
      spoilerText: undefined,
    });
  });

  it('does nothing when the source did not declare the visible shortcode', async () => {
    const post = await remotePost({ variants: [{ source: 'author', text: ':literal:' }] });
    expect(planHistoricalEmojiCleanup(post, [])).toEqual({ kind: 'unchanged' });
  });
});
