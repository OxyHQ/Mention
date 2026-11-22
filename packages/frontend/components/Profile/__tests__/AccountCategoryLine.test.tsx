import type React from 'react';
import { BloomThemeProvider, useTheme } from '@oxy.so/bloom/theme';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

import { AccountCategoryLine } from '../AccountCategoryLine';

/**
 * The profile names ONE category — the account's primary — as plain muted text
 * under the name, the way Instagram names what a professional account is.
 *
 * Two things this file is built to catch, because both pass a tidier fixture:
 *
 *  - "shows the primary" and "shows all of them" are indistinguishable on an
 *    account with a single category, so every assertion here uses THREE and
 *    checks the other two are absent rather than only that the first is
 *    present.
 *  - an accidental `.sort()` reads as correct ordering on an alphabetical
 *    fixture, so the primary is deliberately NOT the alphabetically first id:
 *    sorted, `['music','news','art']` leads with `art`.
 *
 * Oxy's labeller is mocked to answer from a small Spanish catalog for the
 * reader's language and English otherwise (core's per-key fallback), which is
 * what lets one test prove the READER's language reaches it — a component that
 * ignored `i18n.language` would render English.
 */

const READER_LANGUAGE = 'es';
const SPANISH: Record<string, string> = { music: 'Música' };
const ENGLISH: Record<string, string> = { music: 'Music', news: 'News', art: 'Art' };

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: READER_LANGUAGE } }),
}));
jest.mock('@oxy.so/core', () => ({
  accountCategoryLabel: (locale: string, id: string) =>
    (locale === READER_LANGUAGE ? SPANISH[id] : undefined) ?? ENGLISH[id] ?? id,
  subscribeLocales: () => () => {},
  getLocalesVersion: () => 0,
}));

/** Stored order: `music` is the primary. Sorted, `art` would lead. */
const THREE_CATEGORIES = ['music', 'news', 'art'];

/** An id from a vocabulary newer than this build — the shape the server can send. */
const UNKNOWN_ID = 'quantum_basket_weaving';

/** The theme's muted ink, read inside the same provider the line paints from. */
let mutedInk: string | undefined;
function MutedInk() {
  mutedInk = String(useTheme().colors.textSecondary);
  return null;
}

/**
 * Under Bloom's theme provider: the language paints the line's ink from the
 * theme, so it renders only inside one, as in the app.
 */
function renderLine(
  accountCategories: readonly string[] | undefined,
  align: 'center' | 'start' = 'center',
): TestRenderer.ReactTestRenderer {
  let tree: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    tree = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        <MutedInk />
        <Line accountCategories={accountCategories} align={align} />
      </BloomThemeProvider>,
    );
  });
  if (tree === null) throw new Error('the renderer never mounted');
  return tree;
}

function renderedTexts(accountCategories?: readonly string[]): string[] {
  return renderLine(accountCategories)
    .root.findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

/** The subject, under a name of its own so its subtree can be found inside the provider. */
function Line(props: React.ComponentProps<typeof AccountCategoryLine>) {
  return <AccountCategoryLine {...props} />;
}

/** The host nodes the line renders (the provider's own wrapper excluded). */
function lineHosts(tree: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findByType(Line).findAll((node) => typeof node.type === 'string');
}

/** The single rendered node, for the tests that inspect its shape. */
function renderedNode(
  accountCategories: readonly string[],
  align: 'center' | 'start' = 'center',
): ReactTestInstance {
  const hosts = lineHosts(renderLine(accountCategories, align));
  if (hosts.length !== 1) {
    throw new Error('expected exactly one rendered node');
  }
  return hosts[0];
}

describe('AccountCategoryLine', () => {
  it('renders the PRIMARY and none of the others', () => {
    const texts = renderedTexts(THREE_CATEGORIES);

    expect(texts).toEqual(['Música']);
    // The load-bearing half: a component that rendered the whole list would
    // still satisfy the assertion above if it were only `toContain`.
    expect(texts).not.toContain('News');
    expect(texts).not.toContain('Art');
  });

  it('takes element 0 rather than the alphabetically first id', () => {
    // Sorted, this fixture leads with `art` → 'Art'. Reversed, it ends with
    // 'Music' too, so the `news` in the middle is what pins element 0.
    expect(renderedTexts(THREE_CATEGORIES)).toEqual(['Música']);
    expect(renderedTexts(['news', 'music', 'art'])).toEqual(['News']);
  });

  it('renders it in the READER’s language', () => {
    // 'Música' can only come from asking Oxy's labeller in the reader's
    // language; any other language reads 'Music'.
    expect(renderedTexts(['music'])).toEqual(['Música']);
    // And an id the reader's catalog has no entry for still renders English
    // rather than the key or the slug.
    expect(renderedTexts(['news'])).toEqual(['News']);
  });

  it('renders NOTHING — not an empty line — when there is no category', () => {
    for (const categories of [undefined, []]) {
      // `null`, not an empty Text: the margin travels with the text, so a
      // channel without a category keeps exactly the masthead it had before.
      expect(lineHosts(renderLine(categories))).toEqual([]);
    }
  });

  it('renders nothing, and never the slug, when the primary is from a newer vocabulary', () => {
    const tree = renderLine([UNKNOWN_ID]);

    expect(lineHosts(tree)).toEqual([]);
    expect(JSON.stringify(tree.toJSON())).not.toContain(UNKNOWN_ID);
  });

  it('does NOT fall through to the second category when the primary is unnameable', () => {
    // Showing `News` here would state that news is this account's primary
    // category, which is false. Incomplete beats wrong.
    expect(lineHosts(renderLine([UNKNOWN_ID, 'news', 'art']))).toEqual([]);
  });

  it('is plain muted text — no chip, no border, no background, no icon', () => {
    // A single Text node whose only child is the label: a chip would need a
    // wrapping View, and an icon would be a second child.
    const node = renderedNode(THREE_CATEGORIES);

    expect(node.type).toBe('Text');
    expect(node.children).toEqual(['Música']);

    const style = StyleSheet.flatten(node.props.style) as TextStyle;
    expect(style.color).toBe(mutedInk);
    for (const chipLike of [
      'backgroundColor',
      'borderWidth',
      'borderColor',
      'borderRadius',
      'paddingHorizontal',
      'paddingVertical',
      'paddingLeft',
      'paddingRight',
      'paddingTop',
      'paddingBottom',
    ] as const) {
      expect(style[chipLike]).toBeUndefined();
    }
  });

  it('leads the text on the person-family header and centres it on the channel masthead', () => {
    const alignOf = (align: 'center' | 'start') =>
      (StyleSheet.flatten(renderedNode(THREE_CATEGORIES, align).props.style) as TextStyle)
        .textAlign;
    expect(alignOf('center')).toBe('center');
    expect(alignOf('start')).not.toBe('center');
  });
});
