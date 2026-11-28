import { buildMainPost, buildThreadPost } from '@/utils/postBuilder';
import type { ThreadItem } from '@/hooks/useThreadManager';

const NOW = Date.UTC(2026, 0, 1);
const inDays = (days: number) => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();
const OPTIONS = ['Yes', 'No'];

const main = (pollDurationDays?: number) =>
  buildMainPost({
    postContent: 'Q',
    mentions: [],
    mediaIds: [],
    pollTitle: '',
    pollOptions: OPTIONS,
    pollDurationDays,
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
  });

const thread = (pollDurationDays?: number) =>
  buildThreadPost({
    id: 'thread-1',
    text: 'Q',
    mediaIds: [],
    pollOptions: OPTIONS,
    pollTitle: '',
    pollDurationDays,
    showPollCreator: true,
    location: null,
    mentions: [],
    sources: [],
    article: null,
    event: null,
    room: null,
    podcast: null,
    attachmentOrder: [],
    laneId: null,
    replyPermission: ['anyone'],
    reviewReplies: false,
    quotesDisabled: false,
    isSensitive: false,
    publishAs: null,
  } satisfies ThreadItem);

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => jest.useRealTimers());

it('closes a poll after the chosen length, in the root post and a thread box', () => {
  expect(main(1).content.poll?.endTime).toBe(inDays(1));
  expect(thread(14).content.poll?.endTime).toBe(inDays(14));
});

it('keeps a week when nothing was chosen', () => {
  expect(main().content.poll?.endTime).toBe(inDays(7));
  expect(thread().content.poll?.endTime).toBe(inDays(7));
});
