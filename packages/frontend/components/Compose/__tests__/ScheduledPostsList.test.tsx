import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost } from '@mention/shared-types';
import { scheduledPostFixture } from '@/__fixtures__/scheduledPost';
import ScheduledPostsList from '../ScheduledPostsList';

/**
 * Two properties matter on this row and neither is visible from reading it:
 *
 *  1. Tapping the row opens the PREVIEW. It is the only way to reach it, and it
 *     shares the row with a destructive button — a wiring mistake here either
 *     makes the preview unreachable or, worse, puts a delete under the tap that
 *     is supposed to open a read-only view.
 *  2. Cancelling is a DESTRUCTIVE, irreversible server write — the post is
 *     deleted, not unscheduled — so the confirm step is load-bearing rather than
 *     decorative, and it is asserted in both directions.
 */

const mockConfirm = jest.fn();
const mockToast = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      border: '#333',
      card: '#fff',
      primary: '#7c3aed',
      text: '#000',
      textSecondary: '#666',
      textTertiary: '#999',
    },
  }),
}));

jest.mock('@oxyhq/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('@/utils/alerts', () => ({ confirmDialog: (...args: unknown[]) => mockConfirm(...args) }));
jest.mock('@oxyhq/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));
// `@oxyhq/core` ships ESM that jest does not transform, so it is stubbed at the
// one symbol this component uses — the same shape `CollaboratorsList.test.tsx`
// takes. Returning the username IS the real behaviour for a local account, which
// is what every channel is.
jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user?: { username?: string }) => user?.username,
}));

/** Far enough ahead that the row is never accidentally past due. */
const SCHEDULED_AT = new Date(Date.now() + 24 * 60 * 60 * 1000);
const PAST_DUE_AT = new Date(Date.now() - 30 * 1000);

function post(
  overrides: Parameters<typeof scheduledPostFixture>[0] = {},
): HydratedPost {
  return scheduledPostFixture({ scheduledFor: SCHEDULED_AT, ...overrides });
}

function renderList(overrides: Partial<React.ComponentProps<typeof ScheduledPostsList>> = {}) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ScheduledPostsList
        posts={[post()]}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
        onPreview={() => {}}
        onEdit={() => {}}
        onCancel={async () => {}}
        {...overrides}
      />,
    );
  });
  if (!tree) throw new Error('ScheduledPostsList failed to render');
  return tree;
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string | number =>
      typeof child === 'string' || typeof child === 'number')
    .map(String)
    .join(' | ');
}

function press(tree: TestRenderer.ReactTestRenderer, label: string) {
  const button = tree.root.find(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label,
  );
  act(() => {
    button.props.onPress();
  });
}

describe('ScheduledPostsList', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
  });

  it('shows the body and the scheduled time formatted for the reader', () => {
    const tree = renderList();
    const rendered = textContent(tree);

    expect(rendered).toContain('Ship the scheduled queue');
    // Whatever this runtime's locale is, the row must show that exact instant —
    // an ISO string leaking through would fail this.
    expect(rendered).toContain(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(SCHEDULED_AT),
    );

    act(() => tree.unmount());
  });

  it('opens the preview for the tapped post, and deletes nothing', async () => {
    const onPreview = jest.fn();
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderList({ onPreview, onCancel });

    press(tree, 'Preview scheduled post');
    await act(async () => { await Promise.resolve(); });

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview.mock.calls[0][0].id).toBe('post-soon');
    expect(onCancel).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('loads the tapped post into the composer to edit, and deletes nothing', async () => {
    const onEdit = jest.fn();
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderList({ onEdit, onCancel });

    press(tree, 'Edit scheduled post');
    await act(async () => { await Promise.resolve(); });

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0].id).toBe('post-soon');
    expect(onCancel).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('stops advertising a future time once the post is past due', () => {
    const tree = renderList({ posts: [post({ scheduledFor: PAST_DUE_AT })] });
    const rendered = textContent(tree);

    expect(rendered).toContain('Publishing now…');
    expect(rendered).not.toContain(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(PAST_DUE_AT),
    );

    act(() => tree.unmount());
  });

  it('says a past-due post may already be out, instead of promising it never published', async () => {
    const tree = renderList({ posts: [post({ scheduledFor: PAST_DUE_AT })] });

    press(tree, 'Cancel scheduled post');
    await act(async () => { await Promise.resolve(); });

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('may already have been published'),
      }),
    );

    act(() => tree.unmount());
  });

  it('previews a poll-only post by its label rather than a blank row', () => {
    const tree = renderList({
      posts: [post({ content: { pollId: 'poll-9' } })],
    });

    expect(textContent(tree)).toContain('compose.draftWithPoll');

    act(() => tree.unmount());
  });

  it('previews an article post by its headline rather than a blank row', () => {
    const tree = renderList({
      posts: [post({ content: { article: { title: '  Long read  ' } } })],
    });

    expect(textContent(tree)).toContain('Long read');

    act(() => tree.unmount());
  });

  it('does not delete anything when the confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false);
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderList({ onCancel });

    press(tree, 'Cancel scheduled post');
    await act(async () => { await Promise.resolve(); });

    expect(mockConfirm).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('cancels the confirmed post and tells the user it worked', async () => {
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderList({ onCancel });

    press(tree, 'Cancel scheduled post');
    await act(async () => { await Promise.resolve(); });

    expect(onCancel).toHaveBeenCalledWith('post-soon');
    expect(mockToast).toHaveBeenCalledWith('Scheduled post cancelled', { type: 'success' });

    act(() => tree.unmount());
  });

  it('reports a failed cancel instead of pretending it succeeded', async () => {
    const onCancel = jest.fn().mockRejectedValue(new Error('404 from the API'));
    const tree = renderList({ onCancel });

    press(tree, 'Cancel scheduled post');
    await act(async () => { await Promise.resolve(); });

    expect(mockToast).toHaveBeenCalledWith('Failed to cancel the scheduled post', { type: 'error' });

    act(() => tree.unmount());
  });

  it('explains the empty queue rather than showing a blank panel', () => {
    const tree = renderList({ posts: [] });

    expect(textContent(tree)).toContain('No scheduled posts');

    act(() => tree.unmount());
  });

  /**
   * WHOSE QUEUE AN ENTRY IS IN.
   *
   * This list stopped being only the reader's own: `GET /posts/scheduled` merges
   * in the shared editorial queue of every channel they operate, so two people
   * publishing under one byline can see each other's plans. Unlabelled, a
   * channel's entry is indistinguishable from your own — which is the confusion
   * the feature exists to remove, reintroduced one layer up.
   *
   * It names the ACCOUNT and never the person who queued it. A channel's writers
   * are anonymous unless the channel signs its posts, and that decision is made
   * on the server — when it says yes, the writer already arrives in `authors[]`
   * and the preview's byline draws them. This row therefore has no disclosure
   * judgement of its own to get wrong.
   */
  describe('attribution', () => {
    const CHANNEL = {
      id: 'channel-1',
      username: 'techweekly',
      name: { displayName: 'Tech Weekly' },
    };

    function channelEntry(user: HydratedPost['user']): HydratedPost {
      return { ...post(), user };
    }

    it('names the account when the entry is not the reader’s own', () => {
      const tree = renderList({
        posts: [channelEntry(CHANNEL)],
        viewerId: 'viewer-1',
      });

      expect(textContent(tree)).toContain('Tech Weekly');

      act(() => tree.unmount());
    });

    it('says nothing on the reader’s OWN entry', () => {
      // The fixture's author IS `viewer-1`. Labelling every personal row "you"
      // would be noise on the common case, and its absence already reads as mine.
      const tree = renderList({ posts: [post()], viewerId: 'viewer-1' });

      expect(textContent(tree)).not.toContain('Author');

      act(() => tree.unmount());
    });

    it('falls back to the handle when the account has no display name', () => {
      // `name` itself is REQUIRED on a user DTO; it is `name.displayName` that is
      // optional, and absent is the ordinary shape for an unresolved account.
      const tree = renderList({
        posts: [channelEntry({ ...CHANNEL, name: {} })],
        viewerId: 'viewer-1',
      });

      expect(textContent(tree)).toContain('techweekly');

      act(() => tree.unmount());
    });

    it('labels nothing at all while the session is still restoring', () => {
      // `viewerId` is absent for the moment between mount and the session
      // landing. Labelling then would mark the reader's OWN posts as somebody
      // else's, which is worse than labelling nothing.
      const tree = renderList({ posts: [channelEntry(CHANNEL)] });

      expect(textContent(tree)).not.toContain('Tech Weekly');

      act(() => tree.unmount());
    });
  });
});
