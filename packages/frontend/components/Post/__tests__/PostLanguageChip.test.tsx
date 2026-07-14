import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { PostLanguageOption } from '@/utils/postLanguages';

import PostLanguageChip from '../PostLanguageChip';

/**
 * The chip is the ONLY affordance for a post that speaks more than one language,
 * and it must stay quiet: a post with a single rendition never grows a control
 * that does nothing, and pressing the chip switches the language WITHOUT opening
 * the post underneath it.
 *
 * Languages are named from the app's real catalog (`constants/contentLanguages`,
 * unmocked), so a post is read under the same endonym it was written under.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; language?: string }) => {
      const template = options?.defaultValue ?? key;
      return options?.language ? template.replace('{{language}}', options.language) : template;
    },
  }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { primary: '#0000ff', textSecondary: '#888888' } }),
}));

jest.mock('@oxyhq/bloom/loading', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SpinnerIcon: () => <View testID="spinner" /> };
});

jest.mock('@expo/vector-icons', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Ionicons: () => <View testID="icon" /> };
});

/**
 * The picker lands in the app's shared bottom sheet. Mocked at the context
 * module: the real one pulls in Bloom's `BottomSheet`, which ships untranspiled.
 */
const mockSetBottomSheetContent = jest.fn();
const mockOpenBottomSheet = jest.fn();
jest.mock('@/context/BottomSheetContext', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  return {
    BottomSheetContext: createContext({
      setBottomSheetContent: (...args: unknown[]) => mockSetBottomSheetContent(...args),
      openBottomSheet: (...args: unknown[]) => mockOpenBottomSheet(...args),
      bottomSheetRef: { current: null },
    }),
  };
});

const spanish: PostLanguageOption = { tag: 'es-ES', source: 'author', text: 'Hola mundo' };
const english: PostLanguageOption = { tag: 'en', source: 'author', text: 'Hello world' };
const machineItalian: PostLanguageOption = { tag: 'it', source: 'machine', text: 'Ciao mondo' };

/**
 * The chip's one control, found by its accessible role rather than by component
 * type: NativeWind wraps the RN primitives, so the rendered `Pressable` is not
 * the same reference this file imports.
 */
function findAction(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance | undefined {
  return renderer.root.findAll(
    (node: ReactTestInstance) =>
      node.props?.accessibilityRole === 'button' && typeof node.props?.onPress === 'function',
  )[0];
}

function renderChip(
  options: PostLanguageOption[],
  activeTag: string | null,
  onSelect = jest.fn(),
  isTranslating = false,
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PostLanguageChip
        options={options}
        activeTag={activeTag}
        isTranslating={isTranslating}
        onSelect={onSelect}
      />,
    );
  });
  const texts = renderer.root
    .findAllByType(Text)
    .flatMap((node: ReactTestInstance) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
  return { renderer, texts, onSelect };
}

function press(renderer: TestRenderer.ReactTestRenderer, stopPropagation = jest.fn()) {
  const action = findAction(renderer);
  if (!action) throw new Error('the chip has no action to press');
  act(() => {
    action.props.onPress({ stopPropagation });
  });
  return stopPropagation;
}

/** The strings of the picker the chip handed to the shared bottom sheet. */
function pickerTexts(): string[] {
  const content = mockSetBottomSheetContent.mock.calls.at(-1)?.[0] as React.ReactElement | undefined;
  if (!content) throw new Error('the chip opened no picker');
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(content);
  });
  return renderer.root
    .findAllByType(Text)
    .flatMap((node: ReactTestInstance) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

describe('PostLanguageChip', () => {
  beforeEach(() => {
    mockOpenBottomSheet.mockReset();
    mockSetBottomSheetContent.mockReset();
  });

  it('renders nothing for a post with a single rendition', () => {
    const { renderer } = renderChip([english], 'en');
    expect(renderer.toJSON()).toBeNull();
  });

  it('names the language on screen and the one door out of it', () => {
    const { texts } = renderChip([spanish, english], 'es-ES');
    expect(texts).toContain('Showing in Español (España)');
    expect(texts).toContain('View in English');
  });

  it('switches to the only alternative on press', () => {
    const { renderer, onSelect } = renderChip([spanish, english], 'es-ES');

    press(renderer);

    expect(onSelect).toHaveBeenCalledWith('en');
  });

  it('does not let the press fall through to the post it sits on', () => {
    const { renderer } = renderChip([spanish, english], 'es-ES');

    const stopPropagation = press(renderer);

    expect(stopPropagation).toHaveBeenCalled();
  });

  it('offers a picker instead of a single door when there are several renditions', () => {
    const { renderer, texts } = renderChip([spanish, english, machineItalian], 'es-ES');
    expect(texts).toContain('Other languages');
    expect(texts).not.toContain('View in English');

    press(renderer);

    expect(mockOpenBottomSheet).toHaveBeenCalledWith(true);
  });

  it('offers the whole catalog in the picker, not just what the post already has', () => {
    // German has never been translated for this post. It is offered exactly like
    // the renditions that exist: the server takes any tag, and whether that costs
    // a cache read or a model call is not the reader's business.
    const { renderer } = renderChip([spanish, english, machineItalian], 'es-ES');
    press(renderer);

    const texts = pickerTexts();
    expect(texts).toContain('Read this post in');
    expect(texts).toContain('Español (España)');
    expect(texts).toContain('Translated');
    expect(texts).toContain('Translate to');
    expect(texts).toContain('Deutsch');
    // …and never lists a rendition twice.
    expect(texts.filter((text) => text === 'Italiano')).toHaveLength(1);
  });

  it('says so when a machine wrote the body on screen', () => {
    const { texts } = renderChip([english, machineItalian], 'it');
    expect(texts).toContain('Translated to Italiano');
  });

  it('waits quietly while a translation is being fetched', () => {
    const { renderer } = renderChip([english, machineItalian], 'en', jest.fn(), true);

    expect(renderer.root.findAllByProps({ testID: 'spinner' }).length).toBeGreaterThan(0);
    expect(findAction(renderer)).toBeUndefined();
  });
});
