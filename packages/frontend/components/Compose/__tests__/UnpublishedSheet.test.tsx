import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import UnpublishedSheet from '../UnpublishedSheet';

/**
 * The reported bug was discoverability, not plumbing: the scheduled-posts
 * endpoint had been live and routed for a long time with no way to reach it, and
 * users went looking in the drafts sheet. So the thing worth guarding is that
 * BOTH tabs exist on that one sheet and that picking one swaps the panel — a
 * regression here would restore the original complaint even with the hook and
 * the list still perfectly correct.
 */

const mockScheduled: {
  scheduledPosts: { id: string }[];
  isLoading: boolean;
  isError: boolean;
  refetch: jest.Mock;
  cancelScheduledPost: jest.Mock;
} = {
  scheduledPosts: [],
  isLoading: false,
  isError: false,
  refetch: jest.fn(),
  cancelScheduledPost: jest.fn(),
};

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

jest.mock('@/components/Header', () => {
  const react = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return { Header: () => react.createElement(View) };
});

jest.mock('@/components/ui/Button', () => {
  const { TouchableOpacity } = jest.requireActual('react-native');
  return { IconButton: TouchableOpacity };
});

jest.mock('@/hooks/useScheduledPosts', () => ({
  useScheduledPosts: () => mockScheduled,
}));

jest.mock('../DraftsList', () => {
  const react = jest.requireActual('react');
  const { Text: RNText } = jest.requireActual('react-native');
  return { __esModule: true, default: () => react.createElement(RNText, null, 'DRAFTS PANEL') };
});

jest.mock('../ScheduledPostsList', () => {
  const react = jest.requireActual('react');
  const { Text: RNText } = jest.requireActual('react-native');
  return { __esModule: true, default: () => react.createElement(RNText, null, 'SCHEDULED PANEL') };
});

function renderSheet() {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <UnpublishedSheet onClose={() => {}} onLoadDraft={() => {}} currentDraftId={null} />,
    );
  });
  if (!tree) throw new Error('UnpublishedSheet failed to render');
  return tree;
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    // The tab badge renders its count as a NUMBER child, so a string-only
    // filter here would silently drop the very thing one case asserts.
    .filter((child): child is string | number =>
      typeof child === 'string' || typeof child === 'number')
    .map(String)
    .join(' | ');
}

function pressTab(tree: TestRenderer.ReactTestRenderer, label: string) {
  const tab = tree.root
    .findAll((node) => node.props.accessibilityRole === 'tab')
    .find((node) =>
      node.findAllByType(Text).some((child) => child.props.children === label),
    );
  if (!tab) throw new Error(`No tab labelled "${label}"`);
  act(() => {
    tab.props.onPress();
  });
}

describe('UnpublishedSheet', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduled.scheduledPosts = [];
  });

  it('offers a Scheduled tab beside Drafts, opening on Drafts', () => {
    const tree = renderSheet();
    const rendered = textContent(tree);

    expect(rendered).toContain('compose.drafts');
    expect(rendered).toContain('Scheduled');
    expect(rendered).toContain('DRAFTS PANEL');
    expect(rendered).not.toContain('SCHEDULED PANEL');

    act(() => tree.unmount());
  });

  it('swaps to the scheduled queue when that tab is picked', () => {
    const tree = renderSheet();

    pressTab(tree, 'Scheduled');

    const rendered = textContent(tree);
    expect(rendered).toContain('SCHEDULED PANEL');
    expect(rendered).not.toContain('DRAFTS PANEL');

    act(() => tree.unmount());
  });

  it('badges the tab with how many posts are waiting', () => {
    mockScheduled.scheduledPosts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const tree = renderSheet();

    expect(textContent(tree)).toContain('3');

    act(() => tree.unmount());
  });
});
