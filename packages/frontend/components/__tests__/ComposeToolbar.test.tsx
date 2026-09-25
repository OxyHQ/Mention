import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import Ionicons from '@expo/vector-icons/Ionicons';
import ComposeToolbar from '@/components/ComposeToolbar';
import { ScheduleIcon, ScheduleIconActive } from '@/assets/icons/schedule-icon';
import { LaneIcon } from '@/assets/icons/lane-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';

/**
 * WHAT BELONGS IN THIS ROW.
 *
 * The attachment row sits under a compose box and writes properties of THAT
 * post, so it is the same row on the first box and on the tenth. Membership is
 * decided by the wire: a control belongs here if the payload carries its
 * property PER ENTRY, and belongs at the composer level if the server reads it
 * once for the whole batch.
 *
 * Two controls used to be here and are not, and both were measured against the
 * real `POST /posts/thread` before being moved:
 *
 *  - **The schedule.** The controller reads `scheduledFor` from the TOP level
 *    and stamps every entry with the same instant; a per-entry `scheduledFor` is
 *    ignored outright. It is a property of the batch, and it now lives in the
 *    composer's footer.
 *  - **Adding a language.** The declared languages are one set for the whole
 *    composer, so there is no such thing as adding one to a single box. It now
 *    lives on the language tab strip beside the languages it adds to.
 *
 * Because both were rendered only when their handler was passed, deleting the
 * props alone would leave every assertion here vacuously green. So the cases
 * below assert on the GLYPHS, from a toolbar handed every handler it still
 * accepts — a row that regrew either control fails whether or not the prop came
 * back under a new name.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; time?: string }) => {
      const template = options?.defaultValue ?? key;
      return options?.time ? template.replace('{{time}}', options.time) : template;
    },
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
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

jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxy.so/bloom/hooks', () => ({ useHaptics: () => jest.fn() }));
jest.mock('@oxy.so/bloom/pressable-scale', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return { PressableScale: TouchableOpacity };
});
// Bloom's icon barrel is untranspiled ESM. Each glyph becomes a component named
// after its export, so the cases below can still assert on WHICH picture drew.
jest.mock('@oxy.so/bloom/icons', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const glyph = (name: string) =>
    Object.assign((props: object) => <View {...props} />, { displayName: name });
  return {
    RiBroadcastLine: glyph('RiBroadcastLine'),
    RiGroupFill: glyph('RiGroupFill'),
    RiGroupLine: glyph('RiGroupLine'),
    RiMic2Line: glyph('RiMic2Line'),
  };
});

/** Icon-font glyphs live in the Unicode Private Use Area. */
const GLYPH = /[\uE000-\uF8FF]/g;

const noop = () => {};

/** Every handler the row still accepts, so nothing is absent by omission. */
const EVERY_HANDLER: React.ComponentProps<typeof ComposeToolbar> = {
  onMediaPress: noop,
  onPollPress: noop,
  onLocationPress: noop,
  onGifPress: noop,
  onEmojiPress: noop,
  onSourcesPress: noop,
  onArticlePress: noop,
  onEventPress: noop,
  onRoomPress: noop,
  onPodcastPress: noop,
  onCollaboratorsPress: noop,
  onLanePress: noop,
};

function render(props: Partial<React.ComponentProps<typeof ComposeToolbar>> = {}) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<ComposeToolbar {...props} />);
  });
  if (!tree) throw new Error('ComposeToolbar failed to render');
  return tree;
}

function iconNames(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAll((node) => iconName(node) !== undefined).map((node) => String(iconName(node)));
}

/** Ionicons by glyph name, Bloom icons by export name; `undefined` for anything else. */
function iconName(node: TestRenderer.ReactTestInstance): string | undefined {
  if (node.type === Ionicons) return String(node.props.name);
  const name = typeof node.type === 'function' ? (node.type as React.FC).displayName : undefined;
  return name && /^Ri[A-Z]/.test(name) ? name : undefined;
}

/**
 * The WORDS the row renders. Icon fonts draw their glyph as a Private Use Area
 * character inside a `Text`, and `@expo/vector-icons` only swaps it in after its
 * font resolves — so a raw text scrape returns '' or a glyph depending on
 * whether an earlier case in the file already flushed that load. Stripping the
 * PUA range makes these assertions order-independent, which is the difference
 * between "renders no words" and "happened to run first".
 */
function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .map((child) => child.replace(GLYPH, '').trim())
    .filter((child) => child.length > 0)
    .join(' | ');
}

function a11yLabels(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string')
    .map((node) => String(node.props.accessibilityLabel));
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ComposeToolbar — the batch-level controls that were moved out', () => {
  it('offers no way to add a language, even handed every handler it accepts', () => {
    const tree = render(EVERY_HANDLER);

    // Both states of the glyph the control used to draw, so putting it back
    // under any prop name fails here.
    expect(iconNames(tree).filter((name) => /^(language(-outline)?|RiGlobalLine)$/.test(name))).toEqual([]);
    expect(a11yLabels(tree)).not.toContain('Add a language');

    act(() => tree.unmount());
  });

  it('offers no way to schedule, even handed every handler it accepts', () => {
    const tree = render(EVERY_HANDLER);

    // Both cuts of the glyph the control drew, so it cannot come back in either
    // state. The EVENT control's `CalendarIcon` is a different picture and stays
    // — the two shared one until recently, so asserting the schedule's absence
    // by looking for a calendar would find the wrong thing and pass.
    expect(tree.root.findAllByType(ScheduleIcon)).toHaveLength(0);
    expect(tree.root.findAllByType(ScheduleIconActive)).toHaveLength(0);
    expect(tree.root.findAllByType(CalendarIcon)).toHaveLength(1);
    expect(a11yLabels(tree)).not.toContain('Schedule this post');

    act(() => tree.unmount());
  });

  it('CONTROL: the per-entry controls ARE all there, so the two cases above are not vacuous', () => {
    const tree = render(EVERY_HANDLER);

    // Were the row rendering nothing at all — a broken import, a bailed render —
    // the absences above would pass for the wrong reason.
    expect(iconNames(tree)).toEqual(
      expect.arrayContaining(['RiBroadcastLine', 'RiMic2Line', 'RiGroupLine']),
    );
    expect(a11yLabels(tree)).toEqual(
      expect.arrayContaining(['Invite collaborators', 'Choose a lane']),
    );

    act(() => tree.unmount());
  });
});

/**
 * Inviting collaborators is per POST — but a BATCH can have none at all:
 * `POST /posts/thread` refuses `collaboratorIds` on any entry and at the top
 * level alike, with a 400 that fails the whole request. The composer answers
 * that by passing no handler once a second box exists, so the row has to be
 * genuinely absent, not merely disabled.
 */
describe('ComposeToolbar — the collaborators control', () => {
  function collaboratorControl(tree: TestRenderer.ReactTestRenderer) {
    return tree.root.find(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === 'Invite collaborators',
    );
  }

  it('is an icon in the row, not a labelled link', () => {
    const tree = render({ onCollaboratorsPress: noop });

    // It used to render its own "Invite collaborators" text row below the
    // composer. In the icon row the words live in the a11y label alone.
    expect(textContent(tree)).toBe('');
    expect(collaboratorControl(tree).props.className).toBe('p-1');
    expect(iconNames(tree)).toContain('RiGroupLine');

    act(() => tree.unmount());
  });

  it('fills its glyph once the post names someone', () => {
    const tree = render({ onCollaboratorsPress: noop, hasCollaborators: true });

    expect(iconNames(tree)).toContain('RiGroupFill');
    expect(iconNames(tree)).not.toContain('RiGroupLine');

    act(() => tree.unmount());
  });

  it('is absent where the post cannot take collaborators', () => {
    const tree = render({ onMediaPress: noop });

    // A reply, a thread, or an edit of an already-collaborative post passes no
    // handler. Neither glyph — the control has two states and both must be gone.
    expect(iconNames(tree).filter((name) => /^RiGroup(Line|Fill)$/.test(name))).toEqual([]);

    act(() => tree.unmount());
  });

  it('opens the picker when tapped', () => {
    const onCollaboratorsPress = jest.fn();
    const tree = render({ onCollaboratorsPress });

    act(() => collaboratorControl(tree).props.onPress());

    expect(onCollaboratorsPress).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('goes dead once the post holds the maximum collaborators', () => {
    const tree = render({ onCollaboratorsPress: noop, collaboratorsEnabled: false });

    // Disabled, not hidden: a control that vanishes at the limit reads as a bug.
    expect(collaboratorControl(tree).props.disabled).toBe(true);

    act(() => tree.unmount());
  });

  it('tints itself once the post actually names a collaborator', () => {
    const peopleColor = (tree: TestRenderer.ReactTestRenderer) =>
      tree.root
        .findAll((node) => /^RiGroup(Line|Fill)$/.test(iconName(node) ?? ''))[0]?.props.fill;

    const plain = render({ onCollaboratorsPress: noop });
    const plainColor = peopleColor(plain);
    act(() => plain.unmount());

    const withCollaborators = render({ onCollaboratorsPress: noop, hasCollaborators: true });
    const activeColor = peopleColor(withCollaborators);
    act(() => withCollaborators.unmount());

    expect(plainColor).toBe('#666');
    expect(activeColor).toBe('#7c3aed');
  });
});

/**
 * A lane IS per entry — `POST /posts/thread` reads `laneId` off each post — so
 * this row carries it on every box the composer says may have one, which is
 * every box of a beast batch and the root of a thread.
 */
describe('ComposeToolbar — the lane control', () => {
  function laneControl(tree: TestRenderer.ReactTestRenderer) {
    return tree.root.find(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === 'Choose a lane',
    );
  }

  /**
   * The lane control draws `LaneIcon`, ONE cut for both states, so the tint is
   * the whole signal — the `git-branch`/`git-branch-outline` pair it replaced
   * carried it in the shape as well. Asserting both ends is what keeps this from
   * passing against a control that never changes.
   */
  it('tints its glyph once the post is on a lane', () => {
    const plain = render({ onLanePress: noop });
    expect(plain.root.findAllByType(LaneIcon)).toHaveLength(1);
    expect(plain.root.findByType(LaneIcon).props.color).toBe('#666');
    act(() => plain.unmount());

    const assigned = render({ onLanePress: noop, hasLane: true });
    expect(assigned.root.findByType(LaneIcon).props.color).toBe('#7c3aed');
    act(() => assigned.unmount());
  });

  it('is absent where the post cannot take one', () => {
    const tree = render({ onMediaPress: noop });

    // A reply, an edit, and a thread CONTINUATION all pass no handler — the
    // server refuses a lane on each, so there is nothing to disable.
    expect(iconNames(tree).filter((name) => /^git-branch(-outline)?$/.test(name))).toEqual([]);

    act(() => tree.unmount());
  });

  it('opens the picker when tapped', () => {
    const onLanePress = jest.fn();
    const tree = render({ onLanePress });

    act(() => laneControl(tree).props.onPress());

    expect(onLanePress).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });
});

describe('ComposeToolbar — fitting the screen', () => {
  // Every caller puts the row in a `flexDirection: 'row'` wrapper. A horizontal
  // ScrollView there is as wide as its CONTENT unless it may shrink, so with a
  // full row of icons the scroller outgrew the screen: nothing to scroll, and
  // the last icon clipped at the right edge (OxyHQ/Mention#1140).
  it('shrinks to the row it sits in, so the icons scroll instead of overflowing', () => {
    const tree = render(EVERY_HANDLER);
    const scroller = tree.root.findByType(ScrollView);
    const style = StyleSheet.flatten(scroller.props.style);

    expect(scroller.props.horizontal).toBe(true);
    expect(style.flexShrink).toBe(1);
    expect(style.minWidth).toBe(0);

    act(() => tree.unmount());
  });

  it('keeps the last icon off the screen edge', () => {
    const tree = render({ ...EVERY_HANDLER, contentPaddingLeft: 68 });
    const content = StyleSheet.flatten(tree.root.findByType(ScrollView).props.contentContainerStyle);

    expect(content.paddingLeft).toBe(68);
    expect(content.paddingRight).toBeGreaterThan(0);

    act(() => tree.unmount());
  });
});
