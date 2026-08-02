import React from 'react';
import { View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import ComposeThreadItem, { type ComposeThreadItemStyles } from '../ComposeThreadItem';
import type { ThreadItem } from '@/hooks/useThreadManager';

/**
 * The vertical line between avatars belongs to THREAD mode.
 *
 * It means "this post continues the one above it" — true of a thread, where each
 * continuation is created as a reply to its predecessor, and false in beast
 * mode, where the posts are independent and merely share a composer. Drawing it
 * in beast mode asserts a relationship the posts will not have once they go out,
 * which is a lie the author only discovers after publishing.
 *
 * The connectors carry no text and no accessibility role, so nothing but their
 * STYLE identifies them. The composer owns the stylesheet and passes it in, so
 * these cases pass sentinel style objects and look for those exact objects in
 * the rendered tree — an assertion that cannot pass by finding some other View.
 */

const CONNECTOR_ABOVE = { __marker: 'connector-above' } as const;
const CONNECTOR_BELOW = { __marker: 'connector-below' } as const;

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

jest.mock('@oxyhq/bloom/avatar', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Avatar: RNView };
});

jest.mock('@/components/ComposeToolbar', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

jest.mock('@/components/MentionTextInput', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

jest.mock('@/components/Compose', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    VideoPreview: RNView,
    PollCreator: RNView,
    LocationDisplay: RNView,
    ComposeAltButton: RNView,
  };
});

jest.mock('@/components/Compose/InteractionSettingsPills', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

const item: ThreadItem = {
  id: 'thread-1',
  text: 'A continuation',
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
  attachmentOrder: [],
  replyPermission: ['anyone'],
  reviewReplies: false,
  quotesDisabled: false,
  isSensitive: false,
};

/**
 * Only the four entries this row reads for layout carry real values; the rest
 * are distinct empty objects, since the component just forwards them.
 */
const styles = new Proxy({} as Record<string, object>, {
  get(target, key: string) {
    if (key === 'itemConnectorLineAbove') return CONNECTOR_ABOVE;
    if (key === 'itemConnectorLine') return CONNECTOR_BELOW;
    if (!(key in target)) target[key] = {};
    return target[key];
  },
}) as unknown as ComposeThreadItemStyles;

const noop = () => {};

function renderItem(postingMode: 'thread' | 'beast') {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ComposeThreadItem
        item={item}
        isFocused
        isPosting={false}
        postingMode={postingMode}
        userAvatar={undefined}
        userVerified={false}
        onMentionValueChange={noop}
        onFocus={noop}
        onRemove={noop}
        onMediaPress={noop}
        onPollPress={noop}
        onLocationPress={noop}
        onGifPress={noop}
        onEmojiPress={noop}
        onSourcesPress={noop}
        onArticlePress={noop}
        onEventPress={noop}
        onRoomPress={noop}
        onPollTitleChange={noop}
        onPollOptionChange={noop}
        onPollOptionAdd={noop}
        onPollOptionRemove={noop}
        onPollRemove={noop}
        onLocationRemove={noop}
        onMediaRemove={noop}
        onMediaMove={noop}
        onMediaAltPress={noop}
        onArticleRemove={noop}
        onEventRemove={noop}
        onRoomRemove={noop}
        onReplySettingsPress={noop}
        onSensitiveToggle={noop}
        getFileDownloadUrl={(id: string) => id}
        textInputRef={noop}
        styles={styles}
      />,
    );
  });
  if (!tree) throw new Error('ComposeThreadItem failed to render');
  return tree;
}

/** Every View styled with the given sentinel connector style. */
function connectors(tree: TestRenderer.ReactTestRenderer, marker: object) {
  return tree.root.findAllByType(View).filter((node) => {
    const style = node.props.style;
    return Array.isArray(style) ? style.includes(marker) : style === marker;
  });
}

function connectorCount(tree: TestRenderer.ReactTestRenderer, marker: object): number {
  return connectors(tree, marker).length;
}

/** Every `backgroundColor` this node declares in inline style, flattened. */
function inlineBackgroundColors(style: unknown): unknown[] {
  const entries = Array.isArray(style) ? style : [style];
  return entries
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .flatMap((entry) => ('backgroundColor' in entry ? [entry.backgroundColor] : []));
}

describe('ComposeThreadItem — the timeline between avatars', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('draws the connector above and below in THREAD mode', () => {
    const tree = renderItem('thread');

    expect(connectorCount(tree, CONNECTOR_ABOVE)).toBe(1);
    expect(connectorCount(tree, CONNECTOR_BELOW)).toBe(1);

    act(() => tree.unmount());
  });

  it('draws NEITHER connector in beast mode, where the posts are independent', () => {
    const tree = renderItem('beast');

    expect(connectorCount(tree, CONNECTOR_ABOVE)).toBe(0);
    expect(connectorCount(tree, CONNECTOR_BELOW)).toBe(0);

    act(() => tree.unmount());
  });

  /**
   * The connector is a HINT, not a rule: it should read as a faint tether
   * between avatars. It used to interpolate `` `${theme.colors.primary}30` ``
   * into inline style, which is not a colour at all — Bloom resolves `primary`
   * to `rgb(0 98 157)`, so the suffix produced `'rgb(0 98 157)30'`, and
   * react-native-web's own normaliser drops the trailing digits and paints the
   * base colour at FULL opacity (verified: `processColor` returns `#ff00629d`
   * for that string, byte-identical to unsuffixed primary). The line rendered as
   * a solid saturated bar down the composer.
   *
   * So the tint must come from the NativeWind opacity class, which composites
   * through the CSS pipeline, and the connector must declare NO inline
   * background colour — an inline one would win over the class and put the bug
   * straight back.
   */
  it('tints the connector with an opacity CLASS and no inline background', () => {
    const tree = renderItem('thread');

    for (const marker of [CONNECTOR_ABOVE, CONNECTOR_BELOW]) {
      const [node] = connectors(tree, marker);
      expect(node.props.className).toMatch(/\bbg-primary\/\d+\b/);
      expect(inlineBackgroundColors(node.props.style)).toEqual([]);
    }

    act(() => tree.unmount());
  });

  it('still renders the row itself in beast mode — only the line goes', () => {
    const tree = renderItem('beast');

    // Guards the lazy fix: returning null for the whole row would also make the
    // case above pass, while deleting the post the author is writing.
    expect(tree.root.findAllByType(View).length).toBeGreaterThan(1);

    act(() => tree.unmount());
  });
});
