import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost } from '@mention/shared-types';
import { scheduledPostFixture } from '@/__fixtures__/scheduledPost';
import ScheduledPostPreview from '../ScheduledPostPreview';

/**
 * The promise this screen makes is that what you see is what will publish, and
 * exactly two things keep that promise honest:
 *
 *  1. It renders through `PostItem` — the SAME component the feed uses — with
 *     the server's hydrated DTO passed straight through. Hand-rolled markup, or
 *     a reshaped object, would look right on the day it was written and drift
 *     silently afterwards; the identity of the `post` prop is asserted for that
 *     reason.
 *  2. The rendered post is INERT. `PostItem`'s tap target opens `/p/<id>`, which
 *     for an unpublished post is a 404 by the ACL protecting it, and liking or
 *     voting on a post that has not published is not a real action.
 */

const mockConfirm = jest.fn();
const mockToast = jest.fn();
/** What the preview handed to the feed's renderer. `mock`-prefixed so the
 *  hoisted `jest.mock` factory below is allowed to close over it. */
const mockPostItemProps: { post?: HydratedPost } = {};

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; time?: string }) => {
      const template = options?.defaultValue ?? key;
      return options?.time ? template.replace('{{time}}', options.time) : template;
    },
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      border: '#333',
      card: '#fff',
      error: '#dc2626',
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
// Reached through `ScheduledPostsList`, which this screen shares its cancel
// helper with. `@oxyhq/core` ships ESM jest does not transform.
jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user?: { username?: string }) => user?.username,
}));

jest.mock('@/components/Feed/PostItem', () => {
  const react = jest.requireActual('react');
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: (props: { post: HydratedPost }) => {
      // Recorded, not asserted here, so the test can check the exact object
      // identity the preview handed to the feed's renderer.
      mockPostItemProps.post = props.post;
      return react.createElement(RNText, null, 'POST ITEM');
    },
  };
});

const FUTURE_AT = new Date(Date.now() + 24 * 60 * 60 * 1000);
const PAST_DUE_AT = new Date(Date.now() - 30 * 1000);

/** `null` builds a post carrying NO publish time. */
function post(scheduledFor: Date | null = FUTURE_AT): HydratedPost {
  return scheduledPostFixture({ scheduledFor });
}

function renderPreview(
  overrides: Partial<React.ComponentProps<typeof ScheduledPostPreview>> = {},
) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ScheduledPostPreview
        post={post()}
        onBack={() => {}}
        onEdit={() => {}}
        onPublishNow={async () => {}}
        onCancel={async () => {}}
        onCancelled={() => {}}
        {...overrides}
      />,
    );
  });
  if (!tree) throw new Error('ScheduledPostPreview failed to render');
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

describe('ScheduledPostPreview', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete mockPostItemProps.post;
    mockConfirm.mockResolvedValue(true);
  });

  it("renders the post through the feed's own PostItem, with the server's DTO untouched", () => {
    const subject = post();
    const tree = renderPreview({ post: subject });

    expect(textContent(tree)).toContain('POST ITEM');
    // Identity: the feed renderer gets the very object the server sent, so the
    // preview cannot diverge from what publishes.
    expect(mockPostItemProps.post).toBe(subject);

    act(() => tree.unmount());
  });

  it('renders the post inert, so a preview tap cannot open a 404 or like an unpublished post', () => {
    const tree = renderPreview();

    const inert = tree.root.findAll(
      (node) => node.type === View && node.props.pointerEvents === 'none',
    );
    expect(inert).toHaveLength(1);
    expect(
      inert[0].findAllByType(Text).some((node) => node.props.children === 'POST ITEM'),
    ).toBe(true);

    act(() => tree.unmount());
  });

  it('says when the post publishes', () => {
    const tree = renderPreview();

    expect(textContent(tree)).toContain(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(FUTURE_AT),
    );

    act(() => tree.unmount());
  });

  it('warns that a past-due post may already be live instead of showing a stale time', () => {
    const tree = renderPreview({ post: post(PAST_DUE_AT) });
    const rendered = textContent(tree);

    expect(rendered).toContain('Publishing now…');
    expect(rendered).toContain('may already be live');
    expect(rendered).not.toContain(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(PAST_DUE_AT),
    );

    act(() => tree.unmount());
  });

  it('renders a post with no usable time as its own state, never an Invalid Date', () => {
    const tree = renderPreview({ post: post(null) });
    const rendered = textContent(tree);

    expect(rendered).toContain('Time unavailable');
    expect(rendered).not.toContain('Invalid Date');

    act(() => tree.unmount());
  });

  it('goes back without cancelling anything', () => {
    const onBack = jest.fn();
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderPreview({ onBack, onCancel });

    press(tree, 'Back');

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('hands the post to the composer without touching the confirm flow', () => {
    const onEdit = jest.fn();
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderPreview({ onEdit, onCancel });

    press(tree, 'Edit scheduled post');

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('leaves the preview after a confirmed cancel, and stays after a refused one', async () => {
    const onCancelled = jest.fn();
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderPreview({ onCancel, onCancelled });

    press(tree, 'Cancel scheduled post');
    await act(async () => { await Promise.resolve(); });

    expect(onCancel).toHaveBeenCalledWith('post-soon');
    expect(onCancelled).toHaveBeenCalledTimes(1);

    mockConfirm.mockResolvedValue(false);
    press(tree, 'Cancel scheduled post');
    await act(async () => { await Promise.resolve(); });

    // Declining must not navigate away — the count is unchanged from the first,
    // confirmed cancel.
    expect(onCancelled).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('publishes early only after confirming, and leaves the preview when it works', async () => {
    const onPublishNow = jest.fn().mockResolvedValue(undefined);
    const onCancelled = jest.fn();
    const tree = renderPreview({ onPublishNow, onCancelled });

    press(tree, 'Post now');
    await act(async () => { await Promise.resolve(); });

    // Publishing early is one-way and PUBLIC — it federates and notifies — so it
    // asks first, like cancelling does.
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(onPublishNow).toHaveBeenCalledWith('post-soon');
    expect(mockToast).toHaveBeenCalledWith('Post published', { type: 'success' });
    expect(onCancelled).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('publishes nothing when the confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false);
    const onPublishNow = jest.fn().mockResolvedValue(undefined);
    const onCancelled = jest.fn();
    const tree = renderPreview({ onPublishNow, onCancelled });

    press(tree, 'Post now');
    await act(async () => { await Promise.resolve(); });

    expect(onPublishNow).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('reports a refused publish instead of pretending the post went out', async () => {
    const onPublishNow = jest.fn().mockRejectedValue(new Error('409 already published'));
    const onCancelled = jest.fn();
    const tree = renderPreview({ onPublishNow, onCancelled });

    press(tree, 'Post now');
    await act(async () => { await Promise.resolve(); });

    expect(mockToast).toHaveBeenCalledWith('Could not publish the post', { type: 'error' });
    // Staying put matters: the row is still in the queue, so leaving would tell
    // the author it published when it did not.
    expect(onCancelled).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });
});
