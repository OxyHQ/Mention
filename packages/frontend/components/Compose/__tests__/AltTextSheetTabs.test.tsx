import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import AltTextSheet from '../AltTextSheet';

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

jest.mock('@oxyhq/bloom/theme', () => ({
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

jest.mock('@/components/ui/Button', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return { IconButton: TouchableOpacity };
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
      <AltTextSheet
        imageUrl="https://example.invalid/x.png"
        languageTags={['en', 'es-ES']}
        initialTag="en"
        getAlt={() => ''}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
  });
  if (!created) throw new Error('AltTextSheet failed to render');
  return created;
}

/** Outermost node per tab — the role propagates down the nested tree. */
function tabControls(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    (node) => node.props.accessibilityRole === 'tab',
    { deep: false },
  );
}

describe('AltTextSheet language tabs', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('tints the ACTIVE tab with a class, never a hand-built alpha colour', () => {
    const tree = renderSheet();
    const tabs = tabControls(tree);

    expect(tabs).toHaveLength(2);
    expect(tabs[0].props.className).toContain('bg-primary/10');
    expect(tabs[1].props.className).not.toContain('bg-primary/10');

    // The specific failure: an inline backgroundColor here is how the opaque
    // token gets in, and it renders as a readable-looking pill in a screenshot
    // right up until the label happens to use the same token.
    const styles = [tabs[0].props.style].flat().filter(Boolean);
    expect(styles.some((entry) => 'backgroundColor' in (entry as object))).toBe(false);

    act(() => tree.unmount());
  });

  it('switches the active tab when another language is tapped', () => {
    const tree = renderSheet();

    act(() => tabControls(tree)[1].props.onPress());

    const tabs = tabControls(tree);
    expect(tabs[1].props.className).toContain('bg-primary/10');
    expect(tabs[0].props.className).not.toContain('bg-primary/10');

    act(() => tree.unmount());
  });
});
