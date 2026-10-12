import {
  attachmentKeysOf,
  hasDraftContent,
  hasPublishableContent,
  reconcileAttachmentOrder,
  type ComposeContent,
} from '../composeContent';
import { createVariantsState } from '@/utils/composeVariants';

/**
 * The one answer to "may this be published?" and "is there work to keep?".
 *
 * OxyHQ/Mention#1124: a composer holding only a valid event kept Post disabled,
 * because the button's own list of content never included events.
 */

const empty: ComposeContent = {
  postContent: '',
  mediaIds: [],
  pollOptions: [],
  location: null,
  sources: [],
  article: null,
  event: null,
  room: null,
  podcast: null,
  job: null,
  threadItems: [],
};

const EVENT = { name: 'QA launch', date: '2026-10-01T18:00:00.000Z' };

describe('hasPublishableContent', () => {
  it('refuses an empty composer', () => {
    expect(hasPublishableContent(empty)).toBe(false);
    expect(hasPublishableContent({ ...empty, postContent: '   ' })).toBe(false);
  });

  it('accepts a complete event with no text', () => {
    expect(hasPublishableContent({ ...empty, event: EVENT })).toBe(true);
  });

  it('refuses an event without a name or a date', () => {
    expect(hasPublishableContent({ ...empty, event: { ...EVENT, name: '  ' } })).toBe(false);
    expect(hasPublishableContent({ ...empty, event: { ...EVENT, date: '' } })).toBe(false);
  });

  it('accepts every other attachment a post can be made of', () => {
    expect(hasPublishableContent({ ...empty, room: { roomId: 'r', title: 'Room' } })).toBe(true);
    expect(
      hasPublishableContent({ ...empty, podcast: { syraPodcastId: 'p', title: 'Show' } }),
    ).toBe(true);
    expect(hasPublishableContent({ ...empty, article: { title: 'Title', body: '' } })).toBe(true);
    expect(hasPublishableContent({ ...empty, pollOptions: ['', 'yes'] })).toBe(true);
    expect(hasPublishableContent({ ...empty, location: { latitude: 1, longitude: 2 } })).toBe(true);
  });

  it('counts a linked source, the same in every box, and not a source with no link', () => {
    // (A link with no title still cannot be posted — `useComposeValidation`'s
    // invalid-sources check says so — but it is content.)
    expect(
      hasPublishableContent({ ...empty, sources: [{ id: 's', title: '', url: 'https://x.test' }] }),
    ).toBe(true);
    expect(
      hasPublishableContent({ ...empty, sources: [{ id: 's', title: 'Only a title', url: '' }] }),
    ).toBe(false);
  });
});

describe('hasDraftContent', () => {
  const variants = createVariantsState('en');

  it('keeps an event-only composer', () => {
    expect(hasDraftContent({ ...empty, event: EVENT, variants })).toBe(true);
  });

  it('keeps half-written sources, which are not publishable yet', () => {
    expect(
      hasDraftContent({
        ...empty,
        sources: [{ id: 's', title: 'Only a title', url: '' }],
        variants,
      }),
    ).toBe(true);
  });

  it('keeps nothing for an empty composer', () => {
    expect(hasDraftContent({ ...empty, variants })).toBe(false);
  });
});

describe('attachment keys and order', () => {
  const box = { ...empty, showPollCreator: false };

  it('lists a card only for an attachment that counts', () => {
    expect(attachmentKeysOf({ ...box, event: { name: ' ', date: '2026-10-01' } })).toEqual([]);
    expect(
      attachmentKeysOf({ ...box, event: EVENT, mediaIds: [{ id: 'm', type: 'image' }] }),
    ).toEqual(['event', 'media:m']);
  });

  it('keeps a chosen order, drops vanished cards and appends new ones once', () => {
    expect(
      reconcileAttachmentOrder(
        ['media:m', 'poll', 'media:m', 'event'],
        ['event', 'media:m', 'room'],
      ),
    ).toEqual(['media:m', 'event', 'room']);
  });
});
