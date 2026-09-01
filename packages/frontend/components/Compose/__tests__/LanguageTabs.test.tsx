import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import LanguageTabs from '../LanguageTabs';

/**
 * The tab strip is where the author moves between the languages a post carries,
 * CHANGES one, and ADDS one.
 *
 * Adding came back here from the first box's attachment toolbar, where it read
 * as an attachment of that post. It is not one: the renditions are a buffer
 * keyed by (item × language), so declaring a language declares it for the main
 * post and every thread item at once. Offered from one box among several, it
 * made that box look like the one that owned the post's languages — which is the
 * report this strip exists to answer. It belongs beside the languages it adds
 * to, and it must be the ONLY such affordance, or the composer offers one action
 * twice in two shapes.
 *
 * Everything else stays, and the case that looks droppable is the one that
 * matters most: a single-language post still shows its primary tab, because
 * tapping it is the ONLY route to `setPrimaryLanguage` — what the post declares,
 * which decides who the feed serves it to and what federates. Hiding it as "a
 * tab with nowhere to switch" reads plausible and silently deletes that. (The
 * reader-side translate icon IS absent on a post already in the reader's own
 * language; translating that really does nothing.)
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
      primary: '#7c3aed',
      text: '#000',
      textSecondary: '#666',
      textTertiary: '#999',
    },
  }),
}));

jest.mock('@/constants/contentLanguages', () => ({
  describeContentLanguage: (tag: string) =>
    ({ nativeName: tag === 'es' ? 'Español' : 'English', englishName: tag }),
}));

function renderTabs(
  variantTags: string[],
  activeTag = 'en',
  handlers: {
    onSelect?: (tag: string) => void;
    onEdit?: (tag: string) => void;
    onAdd?: () => void;
    canAdd?: boolean;
  } = {},
) {
  let created: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    created = TestRenderer.create(
      <LanguageTabs
        primaryTag="en"
        variantTags={variantTags}
        activeTag={activeTag}
        onSelect={handlers.onSelect ?? (() => {})}
        onEdit={handlers.onEdit ?? (() => {})}
        onAdd={handlers.onAdd ?? (() => {})}
        canAdd={handlers.canAdd}
      />,
    );
  });
  if (!created) throw new Error('LanguageTabs failed to render');
  return created;
}

/** The add affordance — a button, deliberately not a tab: it switches nothing. */
function addControl(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.find(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Add a language',
  );
}

/** The outermost node per tab — the role propagates down five nested nodes. */
function tabControls(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    (node) => node.props.accessibilityRole === 'tab',
    { deep: false },
  );
}

/**
 * The WORDS the strip renders. Icon fonts draw their glyph as a Private Use Area
 * character inside a `Text`, and `@expo/vector-icons` swaps it in only after its
 * font resolves — so a raw scrape yields '' or a glyph depending on whether an
 * earlier case already flushed that load, which makes assertions order-dependent.
 */
const GLYPH = /[\uE000-\uF8FF]/g;

function labels(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .map((child) => child.replace(GLYPH, '').trim())
    .filter((child) => child.length > 0);
}

describe('LanguageTabs', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('keeps the primary tab for a single-language post, and routes it to the picker', () => {
    const onEdit = jest.fn();
    const tree = renderTabs([], 'en', { onEdit });

    const tabs = tabControls(tree);
    expect(tabs).toHaveLength(1);
    expect(labels(tree)).toEqual(['English', 'Language']);

    // This tap is the only route to `setPrimaryLanguage`. Hiding this tab as
    // "nowhere to switch to" would take the post's declared language away from
    // the author entirely — and every other case in this file would still pass.
    act(() => tabs[0].props.onPress());
    expect(onEdit).toHaveBeenCalledWith('en');

    act(() => tree.unmount());
  });

  it('shows one tab per language once the post has more than one', () => {
    const tree = renderTabs(['es']);

    // The add affordance is a button, not a tab, so it does not join this list.
    expect(labels(tree)).toEqual(['English', 'Español', 'Language']);
    expect(tabControls(tree)).toHaveLength(2);

    act(() => tree.unmount());
  });

  it('carries the ONE add affordance, at the end of the strip', () => {
    const onAdd = jest.fn();
    const tree = renderTabs(['es'], 'en', { onAdd });

    act(() => addControl(tree).props.onPress());
    expect(onAdd).toHaveBeenCalledTimes(1);

    // Exactly one — a second, left behind in a box's toolbar, is the bug this
    // move exists to fix.
    expect(
      tree.root.findAll(
        (node) => node.props.accessibilityLabel === 'Add a language',
        { deep: false },
      ),
    ).toHaveLength(1);

    act(() => tree.unmount());
  });

  it('goes dead once the post holds the maximum languages', () => {
    const tree = renderTabs(['es'], 'en', { canAdd: false });

    // Disabled, not hidden: a control that vanishes at the limit reads as a bug.
    expect(addControl(tree).props.disabled).toBe(true);

    act(() => tree.unmount());
  });

  /**
   * Same trap as the schedule chip: `theme.colors.primary` is `rgb(0 98 157)`
   * here, so `` `${primary}1A` `` is read back as FULLY OPAQUE primary and the
   * active tab paints its language name in primary on a primary pill —
   * invisible. The tint must be a class.
   */
  it('tints the ACTIVE tab with a class, never a hand-built alpha colour', () => {
    const tree = renderTabs(['es'], 'en');

    const tabs = tabControls(tree);
    expect(tabs[0].props.className).toContain('bg-primary/10');
    expect(tabs[1].props.className).not.toContain('bg-primary/10');

    const styles = [tabs[0].props.style].flat().filter(Boolean);
    expect(styles.some((entry) => 'backgroundColor' in (entry as object))).toBe(false);

    act(() => tree.unmount());
  });

  it('routes the ACTIVE tab to edit and an inactive one to select', () => {
    const onSelect = jest.fn();
    const onEdit = jest.fn();
    const tree = renderTabs(['es'], 'en', { onSelect, onEdit });

    const tabs = tabControls(tree);
    expect(tabs).toHaveLength(2);

    act(() => tabs[0].props.onPress());
    expect(onEdit).toHaveBeenCalledWith('en');
    expect(onSelect).not.toHaveBeenCalled();

    act(() => tabs[1].props.onPress());
    expect(onSelect).toHaveBeenCalledWith('es');

    act(() => tree.unmount());
  });
});
