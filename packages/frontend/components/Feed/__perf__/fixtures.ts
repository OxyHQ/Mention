import { PostVisibility } from '@mention/shared-types';
import type { HydratedPost, MediaItem, PostUser } from '@mention/shared-types';

/**
 * Deterministic feed fixtures for the row-cost harness: one factory per row
 * type the feed renders. Every id is derived from `seed`, so two runs of the
 * harness mount byte-identical rows and their numbers are comparable.
 */

export const ROW_KINDS = [
  'text',
  'textAvatar',
  'image',
  'multiImage',
  'video',
  'linkPreview',
  'quote',
  'repost',
  'poll',
  'communityNote',
] as const;

export type RowKind = (typeof ROW_KINDS)[number];

const CREATED_AT = '2026-09-01T10:00:00.000Z';

function user(seed: string, withAvatar: boolean): PostUser {
  return {
    id: `user-${seed}`,
    username: `user_${seed.replace(/[^a-z0-9]/gi, '')}`,
    name: { displayName: `User ${seed}` },
    ...(withAvatar ? { avatar: `https://cdn.example.test/avatars/${seed}.jpg` } : {}),
  } as PostUser;
}

function image(seed: string, index: number): MediaItem {
  return {
    id: `img-${seed}-${index}`,
    type: 'image',
    width: 1200,
    height: 800,
    aspectRatio: 1.5,
    orientation: 'landscape',
    url: `https://cdn.example.test/media/${seed}-${index}.jpg`,
    thumbUrl: `https://cdn.example.test/media/${seed}-${index}-thumb.jpg`,
  };
}

function video(seed: string): MediaItem {
  return {
    id: `vid-${seed}`,
    type: 'video',
    width: 1080,
    height: 1920,
    aspectRatio: 0.5625,
    orientation: 'portrait',
    durationSec: 12,
    url: `https://cdn.example.test/media/${seed}.mp4`,
    posterUrl: `https://cdn.example.test/media/${seed}-poster.jpg`,
  };
}

const TEXT =
  'Shipping the new feed today. Measured before and after on the same build, same seed, same fling.';

function base(seed: string, text = TEXT, withAvatar = false): HydratedPost {
  return {
    id: `post-${seed}`,
    user: user(seed, withAvatar),
    authors: [],
    content: { text },
    attachments: {},
    metadata: {
      visibility: PostVisibility.PUBLIC,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    engagement: { likes: 12, downvotes: 0, boosts: 3, replies: 4, saves: 1, views: 240 },
    viewerState: {
      isOwner: false,
      isCollaborator: false,
      isLiked: false,
      isDownvoted: false,
      isBoosted: false,
      isSaved: false,
    },
    permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
  } as HydratedPost;
}

export function makeRow(kind: RowKind, seed: string): HydratedPost {
  switch (kind) {
    case 'text':
      return base(seed);
    case 'textAvatar':
      return base(seed, TEXT, true);
    case 'image': {
      const post = base(seed, TEXT, true);
      post.attachments = { media: [image(seed, 0)] };
      return post;
    }
    case 'multiImage': {
      const post = base(seed, TEXT, true);
      post.attachments = { media: [0, 1, 2, 3].map((i) => image(seed, i)) };
      return post;
    }
    case 'video': {
      const post = base(seed, TEXT, true);
      post.attachments = { media: [video(seed)] };
      return post;
    }
    case 'linkPreview': {
      const url = `https://news.example.test/story/${seed}`;
      const post = base(seed, `Worth reading: ${url}`, true);
      post.documents = [
        {
          url,
          requestedUrl: url,
          canonicalUrl: url,
          title: `Story ${seed}`,
          description: 'A long description of the linked story that wraps onto two lines.',
          siteName: 'News',
          image: `https://news.example.test/og/${seed}.jpg`,
        },
      ] as unknown as HydratedPost['documents'];
      return post;
    }
    case 'quote': {
      const post = base(seed, 'This, exactly. @someone #feed $OXY', true);
      post.quotedPost = base(`${seed}-quoted`, TEXT, true);
      return post;
    }
    case 'repost': {
      const post = base(seed, '', true);
      const original = base(`${seed}-original`, TEXT, true);
      post.boost = { originalPost: original, actor: user(seed, true) };
      return post;
    }
    case 'poll': {
      const post = base(seed, 'Which one?', true);
      post.attachments = {
        poll: {
          question: 'Which one?',
          options: ['Alpha', 'Beta', 'Gamma'],
          endTime: '2099-01-01T00:00:00.000Z',
          votes: { '0': 3, '1': 5, '2': 1 },
          userVotes: {},
        },
      };
      return post;
    }
    case 'communityNote': {
      const post = base(seed, TEXT, true);
      post.communityNote = {
        id: `note-${seed}`,
        text: 'Readers added context: the chart omits the 2025 data.',
        sourceUrls: ['https://example.test/source'],
        status: 'shown',
        createdAt: CREATED_AT,
      } as HydratedPost['communityNote'];
      return post;
    }
  }
}
