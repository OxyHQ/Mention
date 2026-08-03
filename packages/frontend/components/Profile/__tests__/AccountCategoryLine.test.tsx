import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

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
 * The translator is mocked to answer from a small Spanish catalog and to fall
 * back to the `defaultValue` otherwise, which is what lets one test prove the
 * reader's language wins AND another prove the key shape is the one the label
 * is actually stored under — a wrong key would silently render English.
 */

const READER_CATALOG: Record<string, string> = {
  'accounts.accountCategory.music': 'Música',
};

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      READER_CATALOG[key] ?? options?.defaultValue ?? key,
  }),
}));

/** Stored order: `music` is the primary. Sorted, `art` would lead. */
const THREE_CATEGORIES = ['music', 'news', 'art'];

/** An id from a vocabulary newer than this build — the shape the server can send. */
const UNKNOWN_ID = 'quantum_basket_weaving';

/**
 * `act` is required, not decorative: NativeWind's className interop resolves
 * styles through a state update on mount, so an unwrapped `create` tears the
 * renderer down mid-commit and every assertion fails as
 * "Can't access .root on unmounted test renderer" — which reads like a broken
 * component rather than a missing wrapper.
 */
function renderLine(
  accountCategories: readonly string[] | undefined,
  align: 'center' | 'start' = 'center',
): TestRenderer.ReactTestRenderer {
  let tree: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    tree = TestRenderer.create(
      <AccountCategoryLine accountCategories={accountCategories} align={align} />,
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

/** The single rendered node, for the tests that inspect its shape. */
function renderedNode(
  accountCategories: readonly string[],
  align: 'center' | 'start' = 'center',
): TestRenderer.ReactTestRendererJSON {
  const json = renderLine(accountCategories, align).toJSON();
  if (json === null || Array.isArray(json)) {
    throw new Error('expected exactly one rendered node');
  }
  return json;
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

  it('renders it in the READER’s language, under the shared key shape', () => {
    // 'Música' can only come from `accounts.accountCategory.music`; any other
    // key falls through to the English defaultValue and reads 'Music'.
    expect(renderedTexts(['music'])).toEqual(['Música']);
    // And an id the reader's catalog has no entry for still renders English
    // rather than the key or the slug.
    expect(renderedTexts(['news'])).toEqual(['News']);
  });

  it('renders NOTHING — not an empty line — when there is no category', () => {
    for (const categories of [undefined, []]) {
      // `null`, not an empty Text: the margin travels with the text, so a
      // channel without a category keeps exactly the masthead it had before.
      expect(renderLine(categories).toJSON()).toBeNull();
    }
  });

  it('renders nothing, and never the slug, when the primary is from a newer vocabulary', () => {
    const json = renderLine([UNKNOWN_ID]).toJSON();

    expect(json).toBeNull();
    expect(JSON.stringify(json)).not.toContain(UNKNOWN_ID);
  });

  it('does NOT fall through to the second category when the primary is unnameable', () => {
    // Showing `News` here would state that news is this account's primary
    // category, which is false. Incomplete beats wrong.
    expect(renderLine([UNKNOWN_ID, 'news', 'art']).toJSON()).toBeNull();
  });

  it('is plain muted text — no chip, no border, no background, no icon', () => {
    // A single Text node whose only child is the label: a chip would need a
    // wrapping View, and an icon would be a second child.
    const node = renderedNode(THREE_CATEGORIES);

    expect(node.type).toBe('Text');
    expect(node.children).toEqual(['Música']);

    const className = String(node.props.className ?? '');
    expect(className).toContain('text-muted-foreground');
    for (const chipLike of ['bg-', 'border', 'rounded', 'px-', 'py-']) {
      expect(className).not.toContain(chipLike);
    }
  });

  it('leads the text on the person-family header and centres it on the channel masthead', () => {
    // Two complete literal class strings rather than one composed at runtime —
    // NativeWind extracts classes statically, so a concatenated className can
    // silently produce no styling at all.
    expect(String(renderedNode(THREE_CATEGORIES, 'center').props.className)).toContain(
      'text-center',
    );
    expect(String(renderedNode(THREE_CATEGORIES, 'start').props.className)).not.toContain(
      'text-center',
    );
  });
});
