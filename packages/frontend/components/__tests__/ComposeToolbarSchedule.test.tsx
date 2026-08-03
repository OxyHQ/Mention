import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import Ionicons from '@expo/vector-icons/Ionicons';
import ComposeToolbar from '@/components/ComposeToolbar';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { ScheduleIcon, ScheduleIconActive } from '@/assets/icons/schedule-icon';
import { TranslateIcon } from '@/assets/icons/translate-icon';

/**
 * The schedule control is an ICON, like every other attachment control in this
 * row.
 *
 * The chosen time belongs in the author row's time slot, where it replaces
 * "now" — see `ComposeScheduleIndicator.test.tsx`. So the assertions here are
 * about what this control must NOT become: a chip restating a time the header
 * already shows, in a second place that can drift from the first.
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

function renderToolbar(
  props: Partial<React.ComponentProps<typeof ComposeToolbar>> = {},
  onSchedulePress = jest.fn(),
) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<ComposeToolbar onSchedulePress={onSchedulePress} {...props} />);
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
    const tree = renderToolbar();

    expect(textContent(tree)).not.toContain(SCHEDULED_LABEL);
    expect(scheduleControl(tree).props.accessibilityLabel).toBe('Schedule this post');
    expect(scheduleControl(tree).props.className).toBe('p-1');

    act(() => tree.unmount());
  });

  it('stays a bare icon once a time is picked — it never restates the time', () => {
    const tree = renderToolbar({ hasSchedule: true });

    // The author row's time slot shows the time, replacing "now". A chip here
    // too would be a second copy of one fact, free to disagree with the first.
    expect(textContent(tree)).toBe('');
    expect(scheduleControl(tree).props.className).toBe('p-1');

    // And no pill chrome: the shape has to match the siblings, not just the text.
    const styles = [scheduleControl(tree).props.style].flat().filter(Boolean);
    expect(styles.some((entry) => 'backgroundColor' in (entry as object))).toBe(false);

    act(() => tree.unmount());
  });

  it('tints itself once a time is set, like every other icon in the row', () => {
    const unscheduled = renderToolbar();
    const plainColor = unscheduled.root.findByType(ScheduleIcon).props.color;
    act(() => unscheduled.unmount());

    const scheduled = renderToolbar({ hasSchedule: true });
    const activeColor = scheduled.root.findByType(ScheduleIconActive).props.color;
    act(() => scheduled.unmount());

    // The same "this attachment is present" signal poll, media and article give.
    expect(plainColor).toBe('#666');
    expect(activeColor).toBe('#7c3aed');
  });

  /**
   * The stronger half, and the reason the tint above is no longer the whole
   * story: the FILLED cut is drawn once a time is set. A colour-blind reader
   * gets the state from the glyph, and a test that only read the colour could
   * not tell the two icons apart at all.
   */
  it('swaps to the filled glyph once a time is set', () => {
    const unscheduled = renderToolbar();
    expect(unscheduled.root.findAllByType(ScheduleIcon)).toHaveLength(1);
    expect(unscheduled.root.findAllByType(ScheduleIconActive)).toHaveLength(0);
    act(() => unscheduled.unmount());

    const scheduled = renderToolbar({ hasSchedule: true });
    expect(scheduled.root.findAllByType(ScheduleIconActive)).toHaveLength(1);
    expect(scheduled.root.findAllByType(ScheduleIcon)).toHaveLength(0);
    act(() => scheduled.unmount());
  });

  /**
   * The schedule control and the EVENT control used to draw the same
   * `CalendarIcon`, so two different actions in one row were one picture. Pinned
   * because the fix is invisible: nothing fails if a later change points either
   * back at the other's glyph.
   */
  it('does not share its glyph with the event control', () => {
    const tree = renderToolbar({ onEventPress: () => {} });
    expect(tree.root.findAllByType(ScheduleIcon)).toHaveLength(1);
    expect(tree.root.findAllByType(CalendarIcon)).toHaveLength(1);
    act(() => tree.unmount());
  });

  it('opens the picker when tapped in EITHER state, so the time stays changeable', () => {
    const onSchedulePress = jest.fn();

    const unscheduled = renderToolbar({}, onSchedulePress);
    act(() => scheduleControl(unscheduled).props.onPress());
    expect(onSchedulePress).toHaveBeenCalledTimes(1);
    act(() => unscheduled.unmount());

    const scheduled = renderToolbar({ hasSchedule: true }, onSchedulePress);
    act(() => scheduleControl(scheduled).props.onPress());
    expect(onSchedulePress).toHaveBeenCalledTimes(2);
    act(() => scheduled.unmount());
  });
});

/**
 * Inviting collaborators is an attachment like any other, so its entry point is
 * an icon in this row rather than a link sitting under the composer. Matching
 * the siblings is the whole point of the move, so the shape is asserted, not
 * just the presence.
 */
describe('ComposeToolbar — the collaborators control', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  function renderCollaboratorToolbar(
    props: Partial<React.ComponentProps<typeof ComposeToolbar>> = {},
  ) {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(<ComposeToolbar onCollaboratorsPress={() => {}} {...props} />);
    });
    if (!tree) throw new Error('ComposeToolbar failed to render');
    return tree;
  }

  function collaboratorControl(tree: TestRenderer.ReactTestRenderer) {
    return tree.root.find(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === 'Invite collaborators',
    );
  }

  it('is an icon in the row, not a labelled link', () => {
    const tree = renderCollaboratorToolbar();

    // It used to render its own "Invite collaborators" text row below the
    // composer. In the icon row the words live in the a11y label alone.
    expect(textContent(tree)).toBe('');
    expect(collaboratorControl(tree).props.className).toBe('p-1');
    expect(tree.root.findAllByType(Ionicons).map((n) => n.props.name))
      .toContain('people-outline');

    act(() => tree.unmount());
  });

  it('fills its glyph once the post names someone', () => {
    const tree = renderCollaboratorToolbar({ hasCollaborators: true });

    const names = tree.root.findAllByType(Ionicons).map((n) => n.props.name);
    expect(names).toContain('people');
    expect(names).not.toContain('people-outline');

    act(() => tree.unmount());
  });

  it('is absent where the post cannot take collaborators', () => {
    let created: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      created = TestRenderer.create(<ComposeToolbar onMediaPress={() => {}} />);
    });
    if (!created) throw new Error('ComposeToolbar failed to render');
    const tree = created;

    // A reply, a thread, or an edit of an already-collaborative post passes no
    // handler. Neither glyph — the control has two states and both must be gone.
    expect(
      tree.root
        .findAllByType(Ionicons)
        .filter((node) => /^people(-outline)?$/.test(node.props.name)),
    ).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('opens the picker when tapped', () => {
    const onCollaboratorsPress = jest.fn();
    const tree = renderCollaboratorToolbar({ onCollaboratorsPress });

    act(() => collaboratorControl(tree).props.onPress());

    expect(onCollaboratorsPress).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('goes dead once the post holds the maximum collaborators', () => {
    const tree = renderCollaboratorToolbar({ collaboratorsEnabled: false });

    // Disabled, not hidden: a control that vanishes at the limit reads as a bug.
    expect(collaboratorControl(tree).props.disabled).toBe(true);

    act(() => tree.unmount());
  });

  it('tints itself once the post actually names a collaborator', () => {
    const peopleColor = (tree: TestRenderer.ReactTestRenderer) =>
      tree.root
        .findAllByType(Ionicons)
        .find((node) => /^people(-outline)?$/.test(node.props.name))?.props.color;

    const plain = renderCollaboratorToolbar();
    const plainColor = peopleColor(plain);
    act(() => plain.unmount());

    const withCollaborators = renderCollaboratorToolbar({ hasCollaborators: true });
    const activeColor = peopleColor(withCollaborators);
    act(() => withCollaborators.unmount());

    expect(plainColor).toBe('#666');
    expect(activeColor).toBe('#7c3aed');
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

  /**
   * `PostActions` draws the SAME `TranslateIcon`, so the control that writes a
   * language and the badge that reads one look alike. The glyph pair this
   * replaced carried the state in its shape as well; with one cut the tint is
   * the only signal, so the tint is what this pins.
   */
  it("uses the post component's translation icon, tinted by state", () => {
    const plain = renderLanguageToolbar();
    expect(plain.root.findAllByType(TranslateIcon)).toHaveLength(1);
    expect(plain.root.findByType(TranslateIcon).props.color).toBe('#666');
    act(() => plain.unmount());

    const multilingual = renderLanguageToolbar({ hasLanguages: true });
    expect(multilingual.root.findByType(TranslateIcon).props.color).toBe('#7c3aed');
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
      tree.root.findByType(TranslateIcon).props.color;

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
