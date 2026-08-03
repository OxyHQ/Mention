import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import Ionicons from '@expo/vector-icons/Ionicons';
import ComposeThreadItem, { type ComposeThreadItemStyles } from '../ComposeThreadItem';
import { ScheduleIcon, ScheduleIconActive } from '@/assets/icons/schedule-icon';
import { LaneIcon } from '@/assets/icons/lane-icon';
import type { ThreadItem } from '@/hooks/useThreadManager';

/**
 * A CONTINUATION box's attachment row carries the same controls the first box's
 * does, minus exactly the ones the wire will not take for that entry.
 *
 * The report behind this file was that the first box "has many more things than
 * the others". It did — and the fix was not to make the rows identical, but to
 * ask of each control whether `POST /posts/thread` carries its property PER
 * ENTRY. Measured against the real controller:
 *
 *  - **Podcast** — read off `content.podcast` of EVERY entry, in both modes. So
 *    every box gets it.
 *  - **Lane** — read off `laneId` of every entry, but honored on a BEAST entry
 *    and on a thread's ROOT only: a continuation is created as a reply, and the
 *    controller refuses a lane on one with a 400 that fails the WHOLE batch
 *    before anything is written. So a continuation gets it in beast mode and
 *    not in thread mode.
 *  - **Schedule** and **adding a language** — batch-wide, and so on neither
 *    box's row. Pinned in `ComposeToolbar.test.tsx`.
 *  - **Collaborators** — refused on any batch, so the composer stops passing a
 *    handler once a second box exists. Pinned in `ComposeToolbar.test.tsx`.
 *
 * The real `ComposeToolbar` renders here rather than a stand-in: the question is
 * which controls a continuation ENDS UP with, and a mocked row would answer it
 * with whatever the mock was written to say.
 */

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
jest.mock('@oxyhq/bloom/hooks', () => ({ useHaptics: () => jest.fn() }));
jest.mock('@oxyhq/bloom/pressable-scale', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return { PressableScale: TouchableOpacity };
});

jest.mock('@/components/Compose/ComposeIdentityHeader', () => {
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

jest.mock('@/components/Podcast/PodcastCard', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { PodcastCard: RNView };
});

jest.mock('@/components/Post/PostArticlePreview', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

jest.mock('@/components/Post/Attachments/PostAttachmentEvent', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

jest.mock('@/components/RoomCard', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

const baseItem: ThreadItem = {
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

const styles = new Proxy({} as Record<string, object>, {
  get(target, key: string) {
    if (!(key in target)) target[key] = {};
    return target[key];
  },
}) as unknown as ComposeThreadItemStyles;

const noop = () => {};

function renderItem(
  postingMode: 'thread' | 'beast',
  overrides: Partial<React.ComponentProps<typeof ComposeThreadItem>> = {},
) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ComposeThreadItem
        item={baseItem}
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
        onReplySettingsPress={noop}
        onSensitiveToggle={noop}
        onPodcastPress={noop}
        onPodcastRemove={noop}
        getFileDownloadUrl={(id: string) => id}
        textInputRef={noop}
        styles={styles}
        {...overrides}
      />,
    );
  });
  if (!tree) throw new Error('ComposeThreadItem failed to render');
  return tree;
}

/**
 * What the row's attachment toolbar actually DREW, rather than what the row
 * passed it. The toolbar is memoized, so it has no instance to read props off —
 * and rendered output is the better subject anyway: a prop plumbed to a control
 * the toolbar decided not to render is not an affordance the author has.
 */
function iconNames(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Ionicons).map((node) => String(node.props.name));
}

function iconColor(tree: TestRenderer.ReactTestRenderer, name: string): unknown {
  return tree.root.findAllByType(Ionicons).find((node) => node.props.name === name)?.props.color;
}

/** The pressable carrying an accessibility label, or `undefined` if absent. */
function control(tree: TestRenderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(
    (node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === label,
  )[0];
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ComposeThreadItem — the per-entry controls a continuation carries', () => {
  it('offers a podcast of its own, in both modes', () => {
    for (const mode of ['thread', 'beast'] as const) {
      const onPodcastPress = jest.fn();
      const tree = renderItem(mode, { onPodcastPress });

      act(() => control(tree, 'compose.podcast.add').props.onPress());
      // Bound to THIS box's id — a handler that forgot to would attach the show
      // to whichever box the composer happened to have focused.
      expect(onPodcastPress).toHaveBeenCalledWith('thread-1');

      act(() => tree.unmount());
    }
  });

  it("tints the podcast control for the box's OWN show, not a shared one", () => {
    const withShow = renderItem('beast', {
      item: { ...baseItem, podcast: { syraPodcastId: 'show-2', title: 'A show' } },
    });
    expect(iconColor(withShow, 'mic-outline')).toBe('#7c3aed');
    act(() => withShow.unmount());

    const without = renderItem('beast');
    expect(iconColor(without, 'mic-outline')).toBe('#666');
    act(() => without.unmount());
  });

  it('takes a lane in BEAST mode, where the entry is an independent post', () => {
    const onLanePress = jest.fn();
    const tree = renderItem('beast', { onLanePress });

    act(() => control(tree, 'Choose a lane').props.onPress());
    expect(onLanePress).toHaveBeenCalledWith('thread-1');

    act(() => tree.unmount());
  });

  it('draws NO lane control in THREAD mode, where the server would refuse one', () => {
    // A continuation is created as a reply, and the controller 400s a lane on
    // one — failing the whole batch, not just this post. So the control has to
    // be absent rather than disabled: there is nothing the author could do here
    // to make it land.
    const tree = renderItem('thread');

    expect(tree.root.findAllByType(LaneIcon)).toHaveLength(0);
    expect(control(tree, 'Choose a lane')).toBeUndefined();

    act(() => tree.unmount());
  });

  /**
   * `LaneIcon` has ONE cut, so the box's own assignment shows in the tint alone.
   * Both ends are asserted: a control that never changed would pass either half.
   */
  it("tints the lane glyph for the box's own assignment", () => {
    const assigned = renderItem('beast', {
      item: { ...baseItem, laneId: 'lane-1' },
      onLanePress: noop,
    });
    expect(assigned.root.findByType(LaneIcon).props.color).toBe('#7c3aed');
    act(() => assigned.unmount());

    const unassigned = renderItem('beast', { onLanePress: noop });
    expect(unassigned.root.findByType(LaneIcon).props.color).toBe('#666');
    act(() => unassigned.unmount());
  });

  /** The batch-level controls stay off this row, in either mode. */
  it('draws no schedule and no language control in either mode', () => {
    for (const mode of ['thread', 'beast'] as const) {
      const tree = renderItem(mode, { onLanePress: noop });

      expect(tree.root.findAllByType(ScheduleIcon)).toHaveLength(0);
      expect(tree.root.findAllByType(ScheduleIconActive)).toHaveLength(0);
      expect(iconNames(tree).filter((name) => /^language(-outline)?$/.test(name))).toEqual([]);

      // Not vacuous: the per-entry controls next to them ARE drawn. The lane one
      // appears in BOTH modes here because this case hands the item its handler
      // — the item draws what it is given, and it is the COMPOSER that withholds
      // the handler in thread mode, which the case above pins.
      expect(iconNames(tree)).toEqual(expect.arrayContaining(['mic-outline']));
      expect(tree.root.findAllByType(LaneIcon)).toHaveLength(1);

      act(() => tree.unmount());
    }
  });

  it('draws no collaborators control — a batch refuses them outright', () => {
    const tree = renderItem('beast');

    expect(iconNames(tree).filter((name) => /^people(-outline)?$/.test(name))).toEqual([]);

    act(() => tree.unmount());
  });
});
