import { StyleSheet, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import ComposeThreadItem, { type ComposeThreadItemStyles } from '../ComposeThreadItem';
import type { ThreadItem } from '@/hooks/useThreadManager';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

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
 * STYLE identifies them: the language draws each (`timelineLineAbove` and
 * `timelineLineBelow` in `composeLayout`) as an absolute 2pt line under its
 * siblings, the one above the avatar 4pt tall, the one below starting 60pt down.
 * No other View in the row is drawn that way.
 */

type Connector = 'above' | 'below';

// The podcast preview reaches the ESM-only Oxy client; the timeline does not need it.
jest.mock('@/components/Podcast/PostPodcastAttachment', () => ({
  PostPodcastAttachment: () => null,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  ...jest.requireActual('@oxy.so/bloom/theme'),
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

/**
 * The identity row is its own component with its own concerns (the account the
 * box publishes as, the collaborative byline) and its own coverage. These cases
 * are about the LINE BETWEEN the rows, so the header stands in as a plain View
 * that still renders the body the author is writing into.
 */
jest.mock('@/components/Compose/ComposeIdentityHeader', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

jest.mock('@/components/ComposeToolbar', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

jest.mock('@/components/MentionTextInput', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

// Mocked by PATH, one module each, because `ComposeThreadItem` imports them that
// way — the barrel it used to name re-exports eight sheets it never wanted, so a
// barrel mock here would only work by accident of the import style. Stubbing
// `VideoPreview` is load-bearing rather than tidy: reaching the real module pulls
// in `expo-video`, which this suite does not stand up.
jest.mock('@/components/Compose/VideoPreview', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { VideoPreview: RNView };
});
// Both are language views (node functions): a stub draws nothing.
jest.mock('@/components/Compose/PollCreator', () => ({ PollCreator: () => null }));
jest.mock('@/components/Compose/LocationDisplay', () => ({ LocationDisplay: () => null }));
jest.mock('@/components/Compose/ComposeAltButton', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { ComposeAltButton: RNView };
});

// Stubbed like every other child here: this suite is about the connector STYLE,
// and the summary reaches the Oxy SDK to resolve who a pasted link names.
jest.mock('@/components/Compose/ComposeMentionSummary', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

jest.mock('@/components/Compose/InteractionSettingsPills', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

// The room attachment card draws Bloom icons, which Jest cannot load untranspiled.
jest.mock('@/components/RoomCard', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

// Attachment previews draw Bloom's `Card`, an untranspiled ESM subpath.
jest.mock('@oxy.so/bloom/card', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Card: RNView };
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
  podcast: null,
  laneId: null,
  attachmentOrder: [],
  replyPermission: ['anyone'],
  reviewReplies: false,
  quotesDisabled: false,
  isSensitive: false,
  publishAs: null,
};

/** Every entry is a distinct empty object: the component just forwards them. */
const styles = new Proxy({} as Record<string, object>, {
  get(target, key: string) {
    if (!(key in target)) target[key] = {};
    return target[key];
  },
}) as unknown as ComposeThreadItemStyles;

const noop = () => {};

function renderItem(postingMode: 'thread' | 'beast') {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    // Under Bloom's theme: the row's hairline and its dimming are the language's,
    // which paints them from the theme.
    tree = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        <ComposeThreadItem
          item={item}
          variantTexts={[]}
          isFocused
          isPosting={false}
          postingMode={postingMode}
          publishAs={null}
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
          onReplyPermissionChange={noop}
          onQuotesDisabledChange={noop}
          onSensitiveToggle={noop}
          onPodcastPress={noop}
          onPodcastRemove={noop}
          getFileDownloadUrl={(id: string) => id}
          textInputRef={noop}
          styles={styles}
        />
      </BloomThemeProvider>,
    );
  });
  if (!tree) throw new Error('ComposeThreadItem failed to render');
  return tree;
}

/** Every View drawn as the given connector. */
function connectors(tree: TestRenderer.ReactTestRenderer, which: Connector) {
  return tree.root.findAllByType(View).filter((node) => {
    const style = StyleSheet.flatten(node.props.style) ?? {};
    const line = style.position === 'absolute' && style.width === 2 && style.zIndex === -1;
    return line && (which === 'above' ? style.height === 4 : style.top === 60);
  });
}

function connectorCount(tree: TestRenderer.ReactTestRenderer, which: Connector): number {
  return connectors(tree, which).length;
}

describe('ComposeThreadItem — the timeline between avatars', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('draws the connector above and below in THREAD mode', () => {
    const tree = renderItem('thread');

    expect(connectorCount(tree, 'above')).toBe(1);
    expect(connectorCount(tree, 'below')).toBe(1);

    act(() => tree.unmount());
  });

  it('draws NEITHER connector in beast mode, where the posts are independent', () => {
    const tree = renderItem('beast');

    expect(connectorCount(tree, 'above')).toBe(0);
    expect(connectorCount(tree, 'below')).toBe(0);

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
   * So the tint is the language's `primary/20`: the primary token's own colour at
   * a fifth of its alpha, one well-formed colour, never a token with a hex suffix.
   */
  it('tints the connector with the primary token at 20%, never a hex-suffixed token', () => {
    const tree = renderItem('thread');

    for (const which of ['above', 'below'] as const) {
      const [node] = connectors(tree, which);
      expect(StyleSheet.flatten(node.props.style)?.backgroundColor).toEqual(
        expect.stringMatching(/^rgba\(\d+, \d+, \d+, 0\.2\)$/),
      );
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
