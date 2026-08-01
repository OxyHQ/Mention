import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import LanguageTabs from '../LanguageTabs';

/**
 * The tab strip is where the author moves between — and CHANGES — the languages
 * a post carries. Adding one is not its job; that moved to the toolbar, beside
 * the other attachments.
 *
 * So no add affordance may survive in here, or the composer offers the same
 * action twice in two shapes. But everything else has to stay, and the case that
 * looks droppable is the one that matters most: a single-language post still
 * shows its primary tab, because tapping it is the ONLY route to
 * `setPrimaryLanguage` — what the post declares, which decides who the feed
 * serves it to and what federates. Hiding it as "a tab with nowhere to switch"
 * reads plausible and silently deletes that. (The reader-side
 * `PostLanguageChip` DOES hide below two renditions; it only switches between
 * bodies that already exist, so it really does nothing there.)
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
  handlers: { onSelect?: (tag: string) => void; onEdit?: (tag: string) => void } = {},
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
      />,
    );
  });
  if (!created) throw new Error('LanguageTabs failed to render');
  return created;
}

/** The outermost node per tab — the role propagates down five nested nodes. */
function tabControls(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    (node) => node.props.accessibilityRole === 'tab',
    { deep: false },
  );
}

function labels(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
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
    expect(labels(tree)).toEqual(['English']);

    // This tap is the only route to `setPrimaryLanguage`. Hiding this tab as
    // "nowhere to switch to" would take the post's declared language away from
    // the author entirely — and every other case in this file would still pass.
    act(() => tabs[0].props.onPress());
    expect(onEdit).toHaveBeenCalledWith('en');

    act(() => tree.unmount());
  });

  it('shows one tab per language once the post has more than one', () => {
    const tree = renderTabs(['es']);

    expect(labels(tree)).toEqual(['English', 'Español']);

    act(() => tree.unmount());
  });

  it('offers NO add affordance — that lives in the toolbar now', () => {
    const tree = renderTabs(['es']);

    expect(labels(tree)).not.toContain('Add a language');
    // Nor an unlabelled one: the old chip was a button, and the tabs are tabs.
    expect(
      tree.root.findAll((node) => node.props.accessibilityRole === 'button'),
    ).toHaveLength(0);

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
