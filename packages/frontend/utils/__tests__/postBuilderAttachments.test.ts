import { buildMainPost, buildThreadPost } from '@/utils/postBuilder';
import type { ThreadItem } from '@/hooks/useThreadManager';

/**
 * The payload builders ask `composeContent` which attachments count, so the
 * root post and a thread box publish an event or a room on the same rule the
 * Post button enables on (OxyHQ/Mention#1124).
 */

const EVENT = { name: '  Launch  ', date: '2026-10-01T18:00:00.000Z', location: ' Barcelona ', description: '  ' };
const ROOM = { roomId: 'room-1', title: ' Q&A ', status: 'scheduled' as const, topic: ' Tech ', host: 'host-1' };

const main = (overrides: Partial<Parameters<typeof buildMainPost>[0]> = {}) =>
  buildMainPost({
    postContent: '',
    mentions: [],
    mediaIds: [],
    pollTitle: '',
    pollOptions: [],
    article: null,
    event: null,
    room: null,
    podcast: null,
    job: null,
    location: null,
    formattedSources: [],
    attachmentOrder: [],
    replyPermission: ['anyone'],
    reviewReplies: false,
    quotesDisabled: false,
    scheduledAt: null,
    ...overrides,
  });

const box = (overrides: Partial<ThreadItem> = {}): ThreadItem => ({
  id: 'thread-1',
  text: '',
  mediaIds: [],
  pollOptions: [],
  pollTitle: '',
  showPollCreator: false,
  location: null,
  mentions: [],
  sources: [],
  article: null,
  event: null,
  room: null,
  podcast: null,
  laneId: null,
  attachmentOrder: [],
  replyPermission: ['anyone'],
  reviewReplies: false,
  quotesDisabled: false,
  isSensitive: false,
  publishAs: null,
  ...overrides,
});

describe('buildMainPost attachments', () => {
  it('sends a complete event and room, trimmed', () => {
    const post = main({ event: EVENT, room: ROOM, attachmentOrder: ['room', 'event'] });
    expect(post.content.event).toEqual({ name: 'Launch', date: EVENT.date, location: 'Barcelona' });
    expect(post.content.room).toEqual({ roomId: 'room-1', title: 'Q&A', status: 'scheduled', topic: 'Tech', host: 'host-1' });
  });

  it('sends no event without a name, and no room without a title', () => {
    const post = main({ event: { ...EVENT, name: ' ' }, room: { ...ROOM, title: ' ' } });
    expect(post.content.event).toBeUndefined();
    expect(post.content.room).toBeUndefined();
  });
});

describe('buildThreadPost attachments', () => {
  it('uses the same rule and the default card order when the box set none', () => {
    const post = buildThreadPost(box({
      event: EVENT,
      room: ROOM,
      podcast: { syraPodcastId: 'pod-1', title: 'Show' },
      mediaIds: [{ id: 'm1', type: 'image' }],
    }));
    expect(post.content.event).toEqual({ name: 'Launch', date: EVENT.date, location: 'Barcelona' });
    expect(post.content.room).toMatchObject({ roomId: 'room-1', title: 'Q&A' });
    expect(post.content.podcast).toEqual({ syraPodcastId: 'pod-1' });
    expect(post.content.attachments?.length).toBeGreaterThan(0);
  });

  it('drops an event without a date', () => {
    expect(buildThreadPost(box({ text: 'x', event: { name: 'Launch', date: '' } })).content.event).toBeUndefined();
  });
});
