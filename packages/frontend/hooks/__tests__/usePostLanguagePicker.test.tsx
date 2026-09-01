import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { PostLanguageOption } from '@/utils/postLanguages';

import { usePostLanguagePicker } from '../usePostLanguagePicker';

/**
 * The picker has no standing surface: a post never shows a language toolbar, and
 * the only thing on screen is the action bar's translate icon. So there is
 * nothing here to assert about the hook's own rendering — the contract is that
 * it stays shut until asked, and what `PostLanguageSheet` then contains. Both
 * halves are exercised together, through the one door a reader has.
 *
 * Languages are named from the app's real catalog (`constants/contentLanguages`,
 * unmocked), so a post is read under the same endonym it was written under.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { primary: '#0000ff', textSecondary: '#888888' } }),
}));

jest.mock('@expo/vector-icons/Ionicons', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: () => <View testID="icon" /> };
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

let openPicker: () => void;

function mountPicker(options: PostLanguageOption[], activeTag: string | null, onSelect = jest.fn()) {
  const Probe: React.FC = () => {
    openPicker = usePostLanguagePicker(options, activeTag, onSelect);
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  return { renderer, onSelect };
}

/** The sheet the hook handed to the shared bottom sheet, rendered. */
function sheet(): TestRenderer.ReactTestRenderer {
  const content = mockSetBottomSheetContent.mock.calls.at(-1)?.[0] as React.ReactElement | undefined;
  if (!content) throw new Error('nothing was handed to the bottom sheet');
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(content);
  });
  return renderer;
}

function sheetTexts(): string[] {
  return sheet()
    .root.findAllByType(Text)
    .flatMap((node: ReactTestInstance) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

describe('the language picker', () => {
  beforeEach(() => {
    mockOpenBottomSheet.mockReset();
    mockSetBottomSheetContent.mockReset();
  });

  it('renders nothing of its own and opens nothing until it is asked to', () => {
    const { renderer } = mountPicker([spanish, english], 'es-ES');

    expect(renderer.toJSON()).toBeNull();
    expect(mockOpenBottomSheet).not.toHaveBeenCalled();
  });

  it('opens the shared sheet on demand', () => {
    mountPicker([spanish, english], 'es-ES');

    act(() => {
      openPicker();
    });

    expect(mockOpenBottomSheet).toHaveBeenCalledWith(true);
  });

  it('offers the whole catalog, not just what the post already has', () => {
    // German has never been translated for this post. It is offered exactly like
    // the renditions that exist: the server takes any tag, and whether that costs
    // a cache read or a model call is not the reader's business.
    mountPicker([spanish, english, machineItalian], 'es-ES');
    act(() => {
      openPicker();
    });

    const texts = sheetTexts();
    expect(texts).toContain('Read this post in');
    expect(texts).toContain('Español (España)');
    expect(texts).toContain('Translated');
    expect(texts).toContain('Translate to');
    expect(texts).toContain('Deutsch');
    // …and never lists a rendition twice.
    expect(texts.filter((text) => text === 'Italiano')).toHaveLength(1);
  });

  it('hands the chosen tag back and closes behind itself', () => {
    const { onSelect } = mountPicker([spanish, english], 'es-ES');
    act(() => {
      openPicker();
    });

    // Found by the name the reader sees, never by position: NativeWind wraps
    // each row in nodes that carry the same props through, so an index into
    // `findAll` addresses a copy of the wrong row as readily as the right one.
    const row = sheet()
      .root.findAll(
        (node: ReactTestInstance) =>
          typeof node.props?.onPress === 'function' && node.props?.activeOpacity === 0.7,
      )
      .find((node: ReactTestInstance) =>
        node
          .findAllByType(Text)
          .some((text: ReactTestInstance) => text.props.children === 'English'),
      );
    if (!row) throw new Error('the picker offers no English row');
    act(() => {
      row.props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith('en');
    expect(mockOpenBottomSheet).toHaveBeenLastCalledWith(false);
    expect(mockSetBottomSheetContent).toHaveBeenLastCalledWith(null);
  });
});
