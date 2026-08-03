import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { MAX_POST_LINK_PREVIEWS } from '@mention/shared-types/post';
import { useLinkDetection } from '../useLinkDetection';

/**
 * A PASTED PROFILE LINK GETS NO PREVIEW CARD IN THE COMPOSER.
 *
 * The published post does not have one: hydration withholds the card server-side
 * for exactly these URLs, because the reader is shown a mention there rather than
 * a link. Offering it here would show the author an attachment their post is not
 * going to carry — and, once the write boundary rewrites the link out of the body
 * entirely, an attachment for a URL that is no longer in it.
 *
 * These assertions are about what the composer ASKS FOR, since that is where the
 * card comes from: a URL nobody resolves is a URL that gets no card, and it also
 * stops us paying a preview service to scrape our own profile pages.
 */

const mockGetLinkPreview = jest.fn();

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: () => ({
    oxyServices: { getLinkPreview: (...args: unknown[]) => mockGetLinkPreview(...args) },
  }),
}));
jest.mock('@oxyhq/core/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('@/stores/linksStore', () => ({
  useLinksStore: () => ({ getCached: () => undefined, upsertLink: () => {} }),
}));

function Probe({ text }: { text: string }) {
  useLinkDetection(text);
  return null;
}

/** Which URLs the composer actually asked for a preview of. */
async function requestedPreviewUrls(text: string): Promise<string[]> {
  await act(async () => {
    TestRenderer.create(<Probe text={text} />);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(600);
  });
  return mockGetLinkPreview.mock.calls.map(([url]) => url as string);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGetLinkPreview.mockReset();
  mockGetLinkPreview.mockResolvedValue({ title: 'a title' });
});

afterEach(() => {
  jest.useRealTimers();
});

it('asks for no card for a profile link on this instance', async () => {
  expect(await requestedPreviewUrls('meet https://mention.earth/@alice')).toEqual([]);
});

it('asks for no card for the actor-URI spelling either', async () => {
  expect(await requestedPreviewUrls('https://mention.earth/ap/users/alice')).toEqual([]);
});

it('still asks for a card for every other link in the same body', async () => {
  const urls = await requestedPreviewUrls(
    'https://mention.earth/@alice and https://example.com/article',
  );

  expect(urls).toEqual(['https://example.com/article']);
});

it('still asks for a card for a fediverse profile link', async () => {
  // This side cannot tell whether that link becomes a mention, so nothing about
  // it changes — it keeps the card it has always had.
  expect(await requestedPreviewUrls('https://mastodon.social/@alice')).toEqual([
    'https://mastodon.social/@alice',
  ]);
});

it('still asks for a card for a post link on this instance', async () => {
  expect(await requestedPreviewUrls('https://mention.earth/p/abc123')).toEqual([
    'https://mention.earth/p/abc123',
  ]);
});

it('renders one card fewer rather than promoting a link past the cap', async () => {
  // The cap applies BEFORE the profile-link filter, which is what hydration
  // does; matching it is what makes the composer show the published shape.
  const others = Array.from(
    { length: MAX_POST_LINK_PREVIEWS },
    (_, index) => `https://example.com/${index}`,
  );
  const urls = await requestedPreviewUrls(
    `https://mention.earth/@alice ${others.join(' ')}`,
  );

  expect(urls).toEqual(others.slice(0, MAX_POST_LINK_PREVIEWS - 1));
});
