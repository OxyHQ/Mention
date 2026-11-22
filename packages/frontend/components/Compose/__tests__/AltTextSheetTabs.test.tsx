import type React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import AltTextSheet from '../AltTextSheet';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/**
 * The alt-text sheet's language tabs, and the tint that made one invisible.
 *
 * Bloom resolves ACCENT tokens through its tonal engine to `rgb(0 98 157)` —
 * only the `STATUS_COLORS` family (`error`, `success`, …) stays hex. So
 * `` `${theme.colors.primary}1A` `` is a malformed colour that react-native-web
 * renders as the OPAQUE token, and an active tab painted that way shows primary
 * text on a primary pill: measured in a browser at contrast ratio 1.00, the
 * language name completely unreadable. `theme.colors.error` happens to survive
 * the same treatment because it IS hex, which is exactly why the call site is
 * the wrong place to reason about it — use the class.
 */

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
      primary: 'rgb(0 98 157)',
      text: '#000',
      textSecondary: '#666',
      textTertiary: '#999',
    },
  }),
}));

jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/button', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Button: TouchableOpacity };
});
jest.mock('@oxy.so/bloom/icons', () => ({ RiCloseLine: () => null }));
jest.mock('@oxy.so/bloom/textarea', () => ({ Textarea: () => null }));
jest.mock('@oxy.so/bloom/card', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Card: ({ children }: { children?: React.ReactNode }) => <View>{children}</View> };
});

jest.mock('@/constants/contentLanguages', () => ({
  describeContentLanguage: (tag: string) => ({
    tag,
    nativeName: tag === 'en' ? 'English' : 'Español',
    englishName: tag,
  }),
}));

function renderSheet() {
  let created: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    created = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        <AltTextSheet
          imageUrl="https://example.invalid/x.png"
          languageTags={['en', 'es-ES']}
          initialTag="en"
          getAlt={() => ''}
          onSave={() => {}}
          onClose={() => {}}
        />
      </BloomThemeProvider>,
    );
  });
  if (!created) throw new Error('AltTextSheet failed to render');
  return created;
}

/** A tab's fill, as its style draws it. */
function tint(tab: TestRenderer.ReactTestInstance) {
  return StyleSheet.flatten(tab.props.style)?.backgroundColor;
}

/** Outermost node per tab — the role propagates down the nested tree. */
function tabControls(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.props.accessibilityRole === 'tab', { deep: false });
}

describe('AltTextSheet language tabs', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('tints the ACTIVE tab with the primary token at 10%, never a hand-built alpha colour', () => {
    const tree = renderSheet();
    const tabs = tabControls(tree);

    expect(tabs).toHaveLength(2);
    // Bloom's `tokenAlpha`: the token's own colour at a tenth of its alpha. The
    // specific failure was `${primary}1A`: the accent token is an `rgb(...)`
    // string, so a hex suffix reads back as the OPAQUE token and the label on
    // it disappears.
    expect(tint(tabs[0])).toMatch(/^rgba\(\d+, \d+, \d+, 0\.1\)$/);
    expect(tint(tabs[1])).toBeUndefined();

    act(() => tree.unmount());
  });

  it('switches the active tab when another language is tapped', () => {
    const tree = renderSheet();

    act(() => tabControls(tree)[1].props.onPress());

    const tabs = tabControls(tree);
    expect(tint(tabs[1])).toBeDefined();
    expect(tint(tabs[0])).toBeUndefined();

    act(() => tree.unmount());
  });
});
