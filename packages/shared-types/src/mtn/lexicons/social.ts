/**
 * MTN Social Lexicons
 *
 * Canonical schema definitions for all mtn.social.* record types.
 * These are the single source of truth for record shapes.
 */

import type { LexiconDoc } from './types';

export const PostLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.post',
  description: 'A social post record. The fundamental content unit.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['createdAt'],
        properties: {
          text: { type: 'string', maxLength: 5000, description: 'Post text content' },
          facets: {
            type: 'array',
            items: { type: 'ref', ref: '#facet' },
            description: 'Rich text annotations (mentions, links, hashtags)',
          },
          embed: {
            type: 'union',
            refs: ['#mediaEmbed', '#pollEmbed', '#articleEmbed', '#eventEmbed', '#roomEmbed', '#externalEmbed', '#recordEmbed'],
            optional: true,
            description: 'Embedded content',
          },
          reply: {
            type: 'object',
            optional: true,
            properties: {
              root: { type: 'mtn-uri', description: 'URI of the thread root post' },
              parent: { type: 'mtn-uri', description: 'URI of the direct parent post' },
            },
            required: ['root', 'parent'],
          },
          visibility: { type: 'string', enum: ['public', 'followers_only', 'private'] },
          langs: { type: 'array', items: { type: 'string' }, description: 'BCP-47 language tags' },
          labels: {
            type: 'array',
            items: { type: 'ref', ref: 'mtn.social.label#selfLabel' },
            optional: true,
            description: 'Author-applied content labels',
          },
          tags: { type: 'array', items: { type: 'string' }, optional: true, description: 'Arbitrary categorization tags' },
          sources: {
            type: 'array',
            items: { type: 'ref', ref: '#sourceLink' },
            optional: true,
            maxItems: 5,
            description: 'External sources cited',
          },
          location: {
            type: 'object',
            optional: true,
            properties: {
              type: { type: 'string', enum: ['Point'] },
              coordinates: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            },
          },
          status: { type: 'string', enum: ['draft', 'published', 'scheduled'], optional: true },
          scheduledFor: { type: 'datetime', optional: true },
          createdAt: { type: 'datetime' },
        },
      },
    },
    facet: {
      type: 'object',
      properties: {
        index: {
          type: 'object',
          properties: {
            byteStart: { type: 'number', minimum: 0 },
            byteEnd: { type: 'number', minimum: 0 },
          },
          required: ['byteStart', 'byteEnd'],
        },
        features: {
          type: 'array',
          items: {
            type: 'union',
            refs: ['#mentionFeature', '#linkFeature', '#hashtagFeature', '#tagFeature'],
          },
        },
      },
      required: ['index', 'features'],
    },
    mentionFeature: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['mention'] },
        did: { type: 'string', description: 'oxyUserId of the mentioned user' },
      },
      required: ['type', 'did'],
    },
    linkFeature: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['link'] },
        uri: { type: 'uri' },
      },
      required: ['type', 'uri'],
    },
    hashtagFeature: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['hashtag'] },
        tag: { type: 'string' },
      },
      required: ['type', 'tag'],
    },
    tagFeature: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['tag'] },
        tag: { type: 'string' },
      },
      required: ['type', 'tag'],
    },
    mediaEmbed: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['media'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              mediaType: { type: 'string', enum: ['image', 'video', 'gif'] },
              alt: { type: 'string', optional: true },
            },
            required: ['id', 'mediaType'],
          },
        },
      },
      required: ['type', 'items'],
    },
    pollEmbed: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['poll'] },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2 },
        endTime: { type: 'datetime' },
      },
      required: ['type', 'question', 'options', 'endTime'],
    },
    articleEmbed: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['article'] },
        articleId: { type: 'string', optional: true },
        title: { type: 'string' },
        body: { type: 'string', optional: true },
        excerpt: { type: 'string', optional: true },
      },
      required: ['type', 'title'],
    },
    eventEmbed: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['event'] },
        eventId: { type: 'string', optional: true },
        name: { type: 'string' },
        date: { type: 'datetime' },
        location: { type: 'string', optional: true },
        description: { type: 'string', optional: true },
      },
      required: ['type', 'name', 'date'],
    },
    roomEmbed: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['room'] },
        roomId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['scheduled', 'live', 'ended'], optional: true },
        topic: { type: 'string', optional: true },
        host: { type: 'string', optional: true },
      },
      required: ['type', 'roomId', 'title'],
    },
    externalEmbed: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['external'] },
        uri: { type: 'uri' },
        title: { type: 'string' },
        description: { type: 'string', optional: true },
        thumb: { type: 'string', optional: true },
      },
      required: ['type', 'uri', 'title'],
    },
    recordEmbed: {
      type: 'object',
      description: 'Embed another record (quote post, feed generator, etc.)',
      properties: {
        type: { type: 'string', enum: ['record'] },
        record: { type: 'mtn-uri' },
      },
      required: ['type', 'record'],
    },
    sourceLink: {
      type: 'object',
      properties: {
        url: { type: 'uri' },
        title: { type: 'string', optional: true },
      },
      required: ['url'],
    },
  },
};

export const LikeLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.like',
  description: 'A like on a post.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['subject', 'createdAt'],
        properties: {
          subject: { type: 'mtn-uri', description: 'URI of the liked record' },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

export const RepostLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.repost',
  description: 'A repost of an existing post.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['subject', 'createdAt'],
        properties: {
          subject: { type: 'mtn-uri', description: 'URI of the reposted record' },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

export const FollowLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.follow',
  description: 'A follow relationship between users.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['subject', 'createdAt'],
        properties: {
          subject: { type: 'string', description: 'oxyUserId of the followed user' },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

export const BlockLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.block',
  description: 'A block relationship between users.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['subject', 'createdAt'],
        properties: {
          subject: { type: 'string', description: 'oxyUserId of the blocked user' },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

export const ProfileLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.profile',
  description: 'A user profile record.',
  defs: {
    main: {
      type: 'record',
      key: 'literal:self',
      record: {
        type: 'object',
        required: [],
        properties: {
          displayName: { type: 'string', maxLength: 64, optional: true },
          description: { type: 'string', maxLength: 2560, optional: true },
          avatar: { type: 'string', optional: true },
          banner: { type: 'string', optional: true },
          labels: {
            type: 'array',
            items: { type: 'ref', ref: 'mtn.social.label#selfLabel' },
            optional: true,
            description: 'Self-applied content labels',
          },
        },
      },
    },
  },
};

export const FeedGeneratorLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.feedGenerator',
  description: 'A feed generator definition. Allows users/third parties to create custom algorithmic feeds.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['name', 'algorithm', 'createdAt'],
        properties: {
          name: { type: 'string', maxLength: 64 },
          description: { type: 'string', maxLength: 300, optional: true },
          avatar: { type: 'string', optional: true },
          algorithm: { type: 'uri', description: 'Endpoint URI or function identifier for feed generation' },
          createdBy: { type: 'string', description: 'oxyUserId of the creator' },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

export const ThreadgateLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.threadgate',
  description: 'Controls who can reply to a post.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['post', 'createdAt'],
        properties: {
          post: { type: 'mtn-uri', description: 'URI of the gated post' },
          allow: {
            type: 'array',
            items: {
              type: 'union',
              refs: ['#mentionedRule', '#followingRule', '#followerRule', '#listRule'],
            },
            description: 'Rules for who can reply. Empty array means nobody.',
          },
          createdAt: { type: 'datetime' },
        },
      },
    },
    mentionedRule: {
      type: 'object',
      description: 'Only users mentioned in the post can reply.',
      properties: { type: { type: 'string', enum: ['mentionedOnly'] } },
    },
    followingRule: {
      type: 'object',
      description: 'Only users the author follows can reply.',
      properties: { type: { type: 'string', enum: ['followingOnly'] } },
    },
    followerRule: {
      type: 'object',
      description: 'Only followers of the author can reply.',
      properties: { type: { type: 'string', enum: ['followerOnly'] } },
    },
    listRule: {
      type: 'object',
      description: 'Only members of the specified list can reply.',
      properties: {
        type: { type: 'string', enum: ['listOnly'] },
        list: { type: 'mtn-uri', description: 'URI of the allowed list' },
      },
      required: ['type', 'list'],
    },
  },
};

export const PostgateLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.postgate',
  description: 'Controls quoting behavior for a post.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['post', 'createdAt'],
        properties: {
          post: { type: 'mtn-uri', description: 'URI of the gated post' },
          disableQuotes: { type: 'boolean', description: 'Whether quoting this post is disabled' },
          detachedQuoteUris: {
            type: 'array',
            items: { type: 'mtn-uri' },
            optional: true,
            maxItems: 50,
            description: 'Quotes the author has detached (hidden) from this post',
          },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

export const ListLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.list',
  description: 'A list of users for curation or moderation.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['name', 'purpose', 'createdAt'],
        properties: {
          name: { type: 'string', maxLength: 64 },
          purpose: { type: 'string', enum: ['curated', 'moderation'] },
          description: { type: 'string', maxLength: 300, optional: true },
          avatar: { type: 'string', optional: true },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

export const ListItemLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.listItem',
  description: 'An item in a user list.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['subject', 'list', 'createdAt'],
        properties: {
          subject: { type: 'string', description: 'oxyUserId of the list member' },
          list: { type: 'mtn-uri', description: 'URI of the parent list' },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

export const LabelLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.label',
  description: 'Content labels for moderation and content warnings.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['src', 'uri', 'val', 'cts'],
        properties: {
          src: { type: 'string', description: 'oxyUserId of the label source (labeler)' },
          uri: { type: 'mtn-uri', description: 'URI of the labeled content' },
          val: { type: 'string', description: 'Label value/slug' },
          neg: { type: 'boolean', optional: true, description: 'If true, negates (removes) this label' },
          cts: { type: 'datetime', description: 'Timestamp of label creation' },
        },
      },
    },
    selfLabel: {
      type: 'object',
      description: 'A label applied by the content author.',
      properties: {
        val: { type: 'string', description: 'Label value/slug' },
      },
      required: ['val'],
    },
  },
};

export const MuteWordLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.muteWord',
  description: 'A word or phrase to mute from feeds.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['value', 'targets'],
        properties: {
          value: { type: 'string', maxLength: 100, description: 'Word or phrase to mute' },
          targets: {
            type: 'array',
            items: { type: 'string', enum: ['content', 'tag'] },
            description: 'Where to apply: post content text, or tags/hashtags',
          },
          actorTarget: {
            type: 'string',
            enum: ['all', 'exclude-following'],
            optional: true,
            description: 'Whether to mute from all users or exclude followed users',
          },
        },
      },
    },
  },
};

export const StarterPackLexicon: LexiconDoc = {
  lexicon: 1,
  id: 'mtn.social.starterPack',
  description: 'An onboarding bundle of users and feeds to follow.',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['name', 'list', 'createdAt'],
        properties: {
          name: { type: 'string', maxLength: 64 },
          description: { type: 'string', maxLength: 300, optional: true },
          list: { type: 'mtn-uri', description: 'URI of the list of users in this starter pack' },
          feeds: {
            type: 'array',
            items: { type: 'mtn-uri' },
            optional: true,
            description: 'Feed generator URIs included in this pack',
          },
          createdAt: { type: 'datetime' },
        },
      },
    },
  },
};

/** Registry of all social lexicons */
export const SocialLexicons: LexiconDoc[] = [
  PostLexicon,
  LikeLexicon,
  RepostLexicon,
  FollowLexicon,
  BlockLexicon,
  ProfileLexicon,
  FeedGeneratorLexicon,
  ThreadgateLexicon,
  PostgateLexicon,
  ListLexicon,
  ListItemLexicon,
  LabelLexicon,
  MuteWordLexicon,
  StarterPackLexicon,
];
