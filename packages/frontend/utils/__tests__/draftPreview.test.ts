import { PostVisibility, type PostUser } from '@mention/shared-types';
import type { Draft } from '@/hooks/useDrafts';
import { draftToPreviewPost } from '@/utils/draftPreview';

/**
 * Turning a LOCAL draft into something the feed renderer can display.
 *
 * A scheduled post arrives hydrated from the server; a draft has never been near
 * it. So this projection is where the preview's honesty lives: what it can show
 * faithfully, what it can only indicate, and what a draft simply does not carry.
 */

const AUTHOR: PostUser = {
  id: 'viewer-1',
  username: 'author',
  name: { displayName: 'Author' },
};

const resolveMediaUrl = (fileId: string) => `https://cdn.test/${fileId}`;

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 'draft-1',
    postContent: 'A body worth previewing',
    mediaIds: [],
    pollOptions: [],
    showPollCreator: false,
    location: null,
    threadItems: [],
    mentions: [],
    postingMode: 'thread',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Draft;
}

function build(overrides: Partial<Draft> = {}) {
  return draftToPreviewPost({ draft: draft(overrides), author: AUTHOR, resolveMediaUrl });
}

describe('draftToPreviewPost — what it shows faithfully', () => {
  it('shows the body the author typed', () => {
    expect(build().post.content.text).toBe('A body worth previewing');
  });

  it('shows the VIEWER as the author, because they are', () => {
    expect(build().post.user).toBe(AUTHOR);
  });

  it('resolves media through the caller-supplied chokepoint, never a hand-built URL', () => {
    const { post } = build({
      mediaIds: [{ id: 'file-a', type: 'image' }, { id: 'file-b', type: 'video' }],
    });
    expect(post.content.media).toEqual([
      { id: 'file-a', type: 'image', url: 'https://cdn.test/file-a' },
      { id: 'file-b', type: 'video', url: 'https://cdn.test/file-b' },
    ]);
  });

  it('shows a poll with zero votes — the truth for one nobody has seen', () => {
    const { post } = build({
      showPollCreator: true,
      pollTitle: 'Best editor?',
      pollOptions: ['vim', 'emacs', '   '],
    });
    expect(post.content.poll).toEqual({
      question: 'Best editor?',
      options: ['vim', 'emacs'],
      endTime: '',
      votes: {},
      userVotes: {},
    });
  });

  it('omits the poll entirely when the creator is closed', () => {
    expect(build({ showPollCreator: false, pollOptions: ['a', 'b'] }).post.content.poll).toBeUndefined();
  });

  it('shows an article', () => {
    const { post } = build({ article: { title: '  Long read  ', body: 'Body text' } });
    expect(post.content.article?.title).toBe('Long read');
    expect(post.content.article?.body).toBe('Body text');
  });

  it('shows a location in GeoJSON order (lng, lat), not the order it is stored in', () => {
    const { post } = build({ location: { latitude: 52.52, longitude: 13.405, address: 'Berlin' } });
    expect(post.content.location).toEqual({
      type: 'Point',
      coordinates: [13.405, 52.52],
      address: 'Berlin',
    });
  });
});

describe('draftToPreviewPost — what it will not pretend', () => {
  it('reports the rest of a thread rather than showing one post as the whole draft', () => {
    const { remainingThreadItems } = build({
      threadItems: [
        { id: 't1', text: 'second', mediaIds: [], pollOptions: [], showPollCreator: false, location: null, mentions: [] },
        { id: 't2', text: 'third', mediaIds: [], pollOptions: [], showPollCreator: false, location: null, mentions: [] },
      ],
    });
    expect(remainingThreadItems).toBe(2);
  });

  it('reports nothing remaining for a single-post draft', () => {
    expect(build().remainingThreadItems).toBe(0);
  });

  it('claims no engagement, because the post does not exist yet', () => {
    const { post } = build();
    expect(post.engagement).toEqual({ likes: 0, downvotes: 0, boosts: 0, replies: 0 });
    expect(post.viewerState.isLiked).toBe(false);
    expect(post.viewerState.isOwner).toBe(true);
  });

  it('marks the projection a DRAFT, so nothing downstream mistakes it for a live post', () => {
    const { post } = build();
    expect(post.metadata.status).toBe('draft');
    expect(post.metadata.visibility).toBe(PostVisibility.PUBLIC);
  });

  it('namespaces the id so it can never be read as a post id', () => {
    // The preview renders inert, but an id that looked like a post id would be
    // one bad refactor away from routing to `/p/<draft>`.
    expect(build().post.id).toBe('draft:draft-1');
  });

  it('omits media, poll, article and location when the draft has none', () => {
    const { post } = build();
    expect(post.content.media).toBeUndefined();
    expect(post.content.poll).toBeUndefined();
    expect(post.content.article).toBeUndefined();
    expect(post.content.location).toBeUndefined();
  });
});
