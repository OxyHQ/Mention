import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import Ionicons from '@expo/vector-icons/Ionicons';
import ComposeToolbar from '@/components/ComposeToolbar';

/**
 * The schedule control is ONE control with two states, not a control plus a card
 * explaining it.
 *
 * The card that used to sit under the composer is gone, so this control is now
 * the only place the chosen time appears — which makes two things load-bearing
 * and neither is visible in a screenshot: the time has to be IN the control, and
 * the accessibility label has to announce the scheduled state, since a screen
 * reader has no chip shape or tint to read.
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

const SCHEDULED_LABEL = 'Aug 2, 2026, 9:30 AM';

function renderToolbar(scheduledLabel?: string, onSchedulePress = jest.fn()) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ComposeToolbar onSchedulePress={onSchedulePress} scheduledLabel={scheduledLabel} />,
    );
  });
  if (!tree) throw new Error('ComposeToolbar failed to render');
  return tree;
}

function scheduleControl(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.find(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      typeof node.props.accessibilityLabel === 'string' &&
      /Schedule this post|Scheduled for/.test(node.props.accessibilityLabel),
  );
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

describe('ComposeToolbar — the schedule control', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('is a bare icon while the post goes out now', () => {
    const tree = renderToolbar(undefined);

    expect(textContent(tree)).not.toContain(SCHEDULED_LABEL);
    expect(scheduleControl(tree).props.accessibilityLabel).toBe('Schedule this post');

    act(() => tree.unmount());
  });

  it('SHOWS the chosen time itself once a time is picked', () => {
    const tree = renderToolbar(SCHEDULED_LABEL);

    // The card that used to say this is gone, so if the control does not carry
    // the time, nothing does.
    expect(textContent(tree)).toContain(SCHEDULED_LABEL);

    act(() => tree.unmount());
  });

  it('announces the scheduled STATE, not just the action', () => {
    const tree = renderToolbar(SCHEDULED_LABEL);

    // A screen reader gets no tint and no chip shape — the label is the state.
    expect(scheduleControl(tree).props.accessibilityLabel).toBe(
      `Scheduled for ${SCHEDULED_LABEL}. Tap to change.`,
    );

    act(() => tree.unmount());
  });

  /**
   * The tint has to come from `bg-primary/10`, not from concatenating hex alpha
   * onto a theme colour. `theme.colors.primary` is `rgb(0 98 157)` in this
   * theme, so `` `${primary}1A` `` yields a string react-native-web reads back
   * as FULLY OPAQUE primary — the chip paints primary text on a primary pill and
   * the time becomes invisible. Found in a browser; both the type-check and the
   * label assertions above pass straight through it.
   */
  it('tints the chip with a class, never a hand-built alpha colour', () => {
    const tree = renderToolbar(SCHEDULED_LABEL);
    const chip = scheduleControl(tree);

    expect(chip.props.className).toContain('bg-primary/10');

    const styles = [chip.props.style].flat().filter(Boolean);
    expect(styles.some((entry) => 'backgroundColor' in (entry as object))).toBe(false);

    act(() => tree.unmount());
  });

  it('reopens the picker when tapped in EITHER state, so the time stays changeable', () => {
    const onSchedulePress = jest.fn();

    const unscheduled = renderToolbar(undefined, onSchedulePress);
    act(() => scheduleControl(unscheduled).props.onPress());
    expect(onSchedulePress).toHaveBeenCalledTimes(1);
    act(() => unscheduled.unmount());

    const scheduled = renderToolbar(SCHEDULED_LABEL, onSchedulePress);
    act(() => scheduleControl(scheduled).props.onPress());
    // Tapping the chip is the ONLY way back to the picker now, and the picker is
    // where clearing the schedule lives.
    expect(onSchedulePress).toHaveBeenCalledTimes(2);
    act(() => scheduled.unmount());
  });
});

/**
 * Adding a language is an attachment like any other, so it is an icon in this
 * row rather than a dashed chip in the language tab strip. The icon has to be
 * the SAME one the post component marks a translation with, or the control that
 * writes a language and the badge that reads one look like unrelated features.
 */
describe('ComposeToolbar — the language control', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  function renderLanguageToolbar(
    props: Partial<React.ComponentProps<typeof ComposeToolbar>> = {},
  ) {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(<ComposeToolbar onLanguagePress={() => {}} {...props} />);
    });
    if (!tree) throw new Error('ComposeToolbar failed to render');
    return tree;
  }

  function languageControl(tree: TestRenderer.ReactTestRenderer) {
    return tree.root.find(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === 'Add a language',
    );
  }

  it('uses the post component\'s translation icon, in its two states', () => {
    const plain = renderLanguageToolbar();
    expect(plain.root.findAllByType(Ionicons).map((n) => n.props.name))
      .toContain('language-outline');
    act(() => plain.unmount());

    // `PostActions` renders `isTranslated ? 'language' : 'language-outline'`.
    // Matching both states is the point — a different glyph, or the same glyph
    // in both states, still compiles and still looks fine in isolation.
    const multilingual = renderLanguageToolbar({ hasLanguages: true });
    const names = multilingual.root.findAllByType(Ionicons).map((n) => n.props.name);
    expect(names).toContain('language');
    expect(names).not.toContain('language-outline');
    act(() => multilingual.unmount());
  });

  it('is absent when the screen offers no language action', () => {
    let created: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      created = TestRenderer.create(<ComposeToolbar onMediaPress={() => {}} />);
    });
    if (!created) throw new Error('ComposeToolbar failed to render');
    const tree = created;

    // Thread-item toolbars pass no handler: languages are composer-wide, so a
    // per-item copy would offer to translate one post of a set that shares them.
    // Neither glyph — the control has two states and both must be absent.
    expect(
      tree.root
        .findAllByType(Ionicons)
        .filter((node) => /^language(-outline)?$/.test(node.props.name)),
    ).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('opens the picker when tapped', () => {
    const onLanguagePress = jest.fn();
    const tree = renderLanguageToolbar({ onLanguagePress });

    act(() => languageControl(tree).props.onPress());

    expect(onLanguagePress).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('goes dead once the post holds the maximum languages', () => {
    const tree = renderLanguageToolbar({ languageEnabled: false });

    // Disabled, not hidden: a control that vanishes at the limit reads as a bug.
    expect(languageControl(tree).props.disabled).toBe(true);

    act(() => tree.unmount());
  });

  it('tints itself once the post actually carries another language', () => {
    const languageColor = (tree: TestRenderer.ReactTestRenderer) =>
      tree.root
        .findAllByType(Ionicons)
        .find((node) => /^language(-outline)?$/.test(node.props.name))?.props.color;

    const plain = renderLanguageToolbar();
    const plainColor = languageColor(plain);
    act(() => plain.unmount());

    const multilingual = renderLanguageToolbar({ hasLanguages: true });
    const activeColor = languageColor(multilingual);
    act(() => multilingual.unmount());

    // The same "this attachment is present" signal every other icon in the row
    // gives, and the same pairing `PostActions` uses on the reading side.
    expect(plainColor).toBe('#666');
    expect(activeColor).toBe('#7c3aed');
  });
});
