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

const mockRouterPush = jest.fn();

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

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockRouterPush }) }));

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
  const { Text: RNText, TouchableOpacity, View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: (props: { onPreviewDraft: (draft: { id: string }) => void }) =>
      react.createElement(
        View,
        null,
        react.createElement(RNText, null, 'DRAFTS PANEL'),
        react.createElement(TouchableOpacity, {
          key: 'preview',
          accessibilityRole: 'button',
          accessibilityLabel: 'draft-row',
          onPress: () => props.onPreviewDraft({ id: 'draft-1' }),
        }),
      ),
  };
});

jest.mock('../ScheduledPostsList', () => {
  const react = jest.requireActual('react');
  const { Text: RNText, TouchableOpacity, View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: (props: {
      posts: { id: string }[];
      onPreview: (post: unknown) => void;
      onEdit: (post: unknown) => void;
    }) =>
      react.createElement(
        View,
        null,
        react.createElement(
          TouchableOpacity,
          {
            key: 'row',
            accessibilityRole: 'button',
            accessibilityLabel: 'row',
            onPress: () => props.onPreview(props.posts[0]),
          },
          react.createElement(RNText, null, 'SCHEDULED PANEL'),
        ),
        react.createElement(TouchableOpacity, {
          key: 'edit',
          accessibilityRole: 'button',
          accessibilityLabel: 'edit-row',
          onPress: () => props.onEdit(props.posts[0]),
        }),
      ),
  };
});

jest.mock('../DraftPreview', () => {
  const react = jest.requireActual('react');
  const { Text: RNText, TouchableOpacity, View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: (props: { draft: { id: string }; onBack: () => void; onEdit: () => void }) =>
      react.createElement(
        View,
        null,
        react.createElement(
          TouchableOpacity,
          {
            key: 'back',
            accessibilityRole: 'button',
            accessibilityLabel: 'draft-back',
            onPress: props.onBack,
          },
          react.createElement(RNText, null, `DRAFT PREVIEW ${props.draft.id}`),
        ),
        react.createElement(TouchableOpacity, {
          key: 'edit',
          accessibilityRole: 'button',
          accessibilityLabel: 'draft-edit',
          onPress: props.onEdit,
        }),
      ),
  };
});

jest.mock('../ScheduledPostPreview', () => {
  const react = jest.requireActual('react');
  const { Text: RNText, TouchableOpacity, View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: (props: { post: { id: string }; onBack: () => void; onEdit: () => void }) =>
      react.createElement(
        View,
        null,
        react.createElement(
          TouchableOpacity,
          {
            key: 'back',
            accessibilityRole: 'button',
            accessibilityLabel: 'back',
            onPress: props.onBack,
          },
          react.createElement(RNText, null, `PREVIEW ${props.post.id}`),
        ),
        react.createElement(TouchableOpacity, {
          key: 'edit',
          accessibilityRole: 'button',
          accessibilityLabel: 'edit-preview',
          onPress: props.onEdit,
        }),
      ),
  };
});

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof UnpublishedSheet>> = {},
) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <UnpublishedSheet
        onClose={() => {}}
        onLoadDraft={() => {}}
        currentDraftId={null}
        {...overrides}
      />,
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

  it('opens the preview for the tapped post, and comes back to the list', () => {
    mockScheduled.scheduledPosts = [{ id: 'post-soon' }];
    const tree = renderSheet();

    pressTab(tree, 'Scheduled');
    press(tree, 'row');
    expect(textContent(tree)).toContain('PREVIEW post-soon');
    // The list is REPLACED, not stacked behind a second sheet.
    expect(textContent(tree)).not.toContain('SCHEDULED PANEL');

    press(tree, 'back');
    expect(textContent(tree)).toContain('SCHEDULED PANEL');

    act(() => tree.unmount());
  });

  it('takes the preview down when the previewed post leaves the queue', () => {
    mockScheduled.scheduledPosts = [{ id: 'post-soon' }];
    const tree = renderSheet();

    pressTab(tree, 'Scheduled');
    press(tree, 'row');
    expect(textContent(tree)).toContain('PREVIEW post-soon');

    // A cancel (or a refetch that no longer has it) drops the post. Holding the
    // preview by VALUE would keep rendering a post the server no longer has.
    mockScheduled.scheduledPosts = [];
    act(() => {
      tree.update(
        <UnpublishedSheet onClose={() => {}} onLoadDraft={() => {}} currentDraftId={null} />,
      );
    });

    expect(textContent(tree)).not.toContain('PREVIEW post-soon');
    expect(textContent(tree)).toContain('SCHEDULED PANEL');

    act(() => tree.unmount());
  });

  it('opens the composer on the post\'s OWN edit route, and closes the sheet', () => {
    mockScheduled.scheduledPosts = [{ id: 'post-soon' }];
    const onClose = jest.fn();
    const tree = renderSheet({ onClose });

    pressTab(tree, 'Scheduled');
    press(tree, 'edit-row');

    // `/compose?editPostId=` — the composer's SERVER-post edit route, which
    // loads through `edit-source` and saves through `PUT /posts/:id`. Routing it
    // at the local-draft loader instead would create a second post and strand
    // the scheduled one.
    expect(mockRouterPush).toHaveBeenCalledWith('/compose?editPostId=post-soon');
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('edits from inside the preview too, on the same route', () => {
    mockScheduled.scheduledPosts = [{ id: 'post-soon' }];
    const tree = renderSheet();

    pressTab(tree, 'Scheduled');
    press(tree, 'row');
    press(tree, 'edit-preview');

    expect(mockRouterPush).toHaveBeenCalledWith('/compose?editPostId=post-soon');

    act(() => tree.unmount());
  });

  it('badges the tab with how many posts are waiting', () => {
    mockScheduled.scheduledPosts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const tree = renderSheet();

    expect(textContent(tree)).toContain('3');

    act(() => tree.unmount());
  });

  it('previews a DRAFT from the drafts tab, and comes back to the list', () => {
    const tree = renderSheet();

    press(tree, 'draft-row');
    expect(textContent(tree)).toContain('DRAFT PREVIEW draft-1');
    // Replaced, not stacked — the same shape the scheduled preview uses.
    expect(textContent(tree)).not.toContain('DRAFTS PANEL');

    press(tree, 'draft-back');
    expect(textContent(tree)).toContain('DRAFTS PANEL');

    act(() => tree.unmount());
  });

  it('loads the previewed draft into the composer, leaving the preview first', () => {
    const onLoadDraft = jest.fn();
    const tree = renderSheet({ onLoadDraft });

    press(tree, 'draft-row');
    press(tree, 'draft-edit');

    expect(onLoadDraft).toHaveBeenCalledTimes(1);
    expect(onLoadDraft.mock.calls[0][0].id).toBe('draft-1');
    // Leaving the preview matters: the composer is behind this sheet, so staying
    // would leave the user looking at a preview of what they are now editing.
    expect(textContent(tree)).not.toContain('DRAFT PREVIEW');

    act(() => tree.unmount());
  });
});
