import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ScheduledPost } from '@/hooks/useScheduledPosts';
import ScheduledPostsList from '../ScheduledPostsList';

/**
 * Cancelling a scheduled post is a DESTRUCTIVE, irreversible server write — the
 * post is deleted, not unscheduled — so the confirm step is load-bearing rather
 * than decorative, and it is asserted in both directions here.
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

const SCHEDULED_AT = new Date('2026-08-02T09:30:00.000Z');

const POSTS: ScheduledPost[] = [
  {
    id: 'post-soon',
    text: 'Ship the scheduled queue',
    scheduledFor: SCHEDULED_AT,
    mediaCount: 2,
    hasPoll: false,
    articleTitle: null,
  },
];

function renderList(overrides: Partial<React.ComponentProps<typeof ScheduledPostsList>> = {}) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ScheduledPostsList
        posts={POSTS}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
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
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

function pressCancel(tree: TestRenderer.ReactTestRenderer) {
  const button = tree.root.find(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Cancel scheduled post',
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

  it('does not delete anything when the confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false);
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderList({ onCancel });

    pressCancel(tree);
    await act(async () => { await Promise.resolve(); });

    expect(mockConfirm).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('cancels the confirmed post and tells the user it worked', async () => {
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const tree = renderList({ onCancel });

    pressCancel(tree);
    await act(async () => { await Promise.resolve(); });

    expect(onCancel).toHaveBeenCalledWith('post-soon');
    expect(mockToast).toHaveBeenCalledWith('Scheduled post cancelled', { type: 'success' });

    act(() => tree.unmount());
  });

  it('reports a failed cancel instead of pretending it succeeded', async () => {
    const onCancel = jest.fn().mockRejectedValue(new Error('404 from the API'));
    const tree = renderList({ onCancel });

    pressCancel(tree);
    await act(async () => { await Promise.resolve(); });

    expect(mockToast).toHaveBeenCalledWith('Failed to cancel the scheduled post', { type: 'error' });

    act(() => tree.unmount());
  });

  it('explains the empty queue rather than showing a blank panel', () => {
    const tree = renderList({ posts: [] });

    expect(textContent(tree)).toContain('No scheduled posts');

    act(() => tree.unmount());
  });
});
