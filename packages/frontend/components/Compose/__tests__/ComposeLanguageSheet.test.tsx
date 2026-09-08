import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { CheckCircleIcon } from '@/assets/icons/check-circle-icon';
import ComposeLanguageSheet from '../ComposeLanguageSheet';

/**
 * The post's languages, now a sheet behind the bottom bar's pill rather than a
 * strip of chips above the composer.
 *
 * THE CASE THAT LOOKS DROPPABLE IS THE ONE THAT MATTERS MOST, and it is the same
 * one the strip's own tests defended: a SINGLE-language post still lists its
 * language, because tapping it is the only route to `setPrimaryLanguage` — what
 * the post declares, which decides who the feed serves it to and what federates.
 * "One language, nothing to switch to, so show nothing" reads plausible and
 * silently deletes that.
 *
 * The other half is the switch: with more than one language the sheet is how the
 * author moves the WHOLE composer — main post and every thread item — between
 * renditions, so an inactive row selects rather than edits.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: { primary: '#7c3aed', text: '#fff', textTertiary: '#888' },
  }),
}));

/** Bloom's row, reduced to what this file asserts on: a press target with a title. */
jest.mock('@oxyhq/bloom/item', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text: RNText, TouchableOpacity: RNTouchable } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Item: ({
      title,
      subtitle,
      onPress,
      disabled,
      trailing,
    }: {
      title: string;
      subtitle?: string;
      onPress?: () => void;
      disabled?: boolean;
      trailing?: React.ReactNode;
    }) =>
      React.createElement(
        RNTouchable,
        { onPress, disabled, accessibilityState: { disabled: Boolean(disabled) } },
        React.createElement(RNText, null, title),
        subtitle ? React.createElement(RNText, null, subtitle) : null,
        trailing ?? null,
      ),
  };
});

jest.mock('@/components/ui/Button', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { TouchableOpacity: RNTouchable } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    IconButton: ({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) =>
      React.createElement(RNTouchable, { onPress }, children),
  };
});

jest.mock('@/assets/icons/close-icon', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { CloseIcon: RNView };
});

jest.mock('@expo/vector-icons/Ionicons', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RNView };
});

function render(props: Partial<React.ComponentProps<typeof ComposeLanguageSheet>> = {}) {
  const handlers = {
    onSelect: jest.fn(),
    onEdit: jest.fn(),
    onAdd: jest.fn(),
    onClose: jest.fn(),
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <ComposeLanguageSheet
        primaryTag="en"
        variantTags={[]}
        activeTag="en"
        canAdd
        {...handlers}
        {...props}
      />,
    );
  });
  if (!renderer) throw new Error('sheet did not render');
  return { renderer, ...handlers };
}

/** The rows, in order, named by the first string each renders. */
function rows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(TouchableOpacity)
    .map((row) => row.findAllByType(Text)[0]?.props.children as string | undefined);
}

describe('ComposeLanguageSheet', () => {
  it('lists a single-language post and routes it to the picker', () => {
    const { renderer, onEdit, onSelect } = render();

    expect(rows(renderer)).toContain('English');

    act(() => {
      renderer.root
        .findAllByType(TouchableOpacity)
        .find((row) => row.findAllByType(Text)[0]?.props.children === 'English')
        ?.props.onPress();
    });

    expect(onEdit).toHaveBeenCalledWith('en');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('switches the composer when a non-active language is tapped', () => {
    const { renderer, onSelect, onEdit } = render({
      variantTags: ['es-ES'],
      activeTag: 'en',
    });

    act(() => {
      renderer.root
        .findAllByType(TouchableOpacity)
        .find((row) => row.findAllByType(Text)[0]?.props.children === 'Español (España)')
        ?.props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith('es-ES');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('closes itself after a switch, so the composer is what the author lands on', () => {
    const { renderer, onClose } = render({ variantTags: ['es-ES'] });

    act(() => {
      renderer.root
        .findAllByType(TouchableOpacity)
        .find((row) => row.findAllByType(Text)[0]?.props.children === 'Español (España)')
        ?.props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
  });

  /**
   * The picker lives in the SAME bottom-sheet host, so a close from here is a
   * `dismiss()` on the ref the picker just called `present()` on. Closing on
   * these two paths made editing and adding a language unreachable: the picker
   * opened and vanished in the same frame.
   */
  it('stays out of the way when it hands over to the picker', () => {
    const { renderer, onClose, onEdit } = render();

    act(() => {
      renderer.root
        .findAllByType(TouchableOpacity)
        .find((row) => row.findAllByType(Text)[0]?.props.children === 'English')
        ?.props.onPress();
    });

    expect(onEdit).toHaveBeenCalledWith('en');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hands add over to the picker without closing either', () => {
    const { renderer, onAdd, onClose } = render();

    act(() => {
      renderer.root
        .findAllByType(TouchableOpacity)
        .find((row) => row.findAllByType(Text)[0]?.props.children === 'Add language')
        ?.props.onPress();
    });

    expect(onAdd).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('marks the active language, drawing the real icon', () => {
    const { renderer } = render({ variantTags: ['es-ES'], activeTag: 'es-ES' });

    const marks = renderer.root.findAllByType(CheckCircleIcon);
    expect(marks).toHaveLength(1);
  });

  it('goes dead once the post holds the maximum languages', () => {
    const { renderer, onAdd } = render({ canAdd: false });

    const add = renderer.root
      .findAllByType(TouchableOpacity)
      .find((row) => row.findAllByType(Text)[0]?.props.children === 'Add language');
    expect(add?.props.disabled).toBe(true);

    act(() => {
      add?.props.onPress?.();
    });

    expect(onAdd).not.toHaveBeenCalled();
  });
});
