import {
  ACCOUNT_CATEGORY_IDS,
  MAX_ACCOUNT_CATEGORIES,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  type AccountCategoryId,
} from '@oxyhq/contracts';

import {
  ACCOUNT_CATEGORY_ENGLISH_LABELS,
  accountCategoriesEqual,
  isKnownAccountCategoryId,
  nameableAccountCategoryIds,
  primaryAccountCategoryId,
  promoteAccountCategoryToPrimary,
  toggleAccountCategory,
} from '@/utils/accountCategories';

/**
 * A three-category account whose primary is NOT the alphabetically first id, and
 * not the shortest or the last either.
 *
 * Every ordering assertion below uses it, because the tidier fixtures cannot
 * tell the implementations apart: with one category, "shows the primary" and
 * "shows all of them" agree; with an alphabetical fixture, a stray `.sort()`
 * passes as correct ordering. Sorted, this reads `art, music, news` — so any
 * assertion that still passes on the sorted list is not testing the order.
 */
const STORED: readonly AccountCategoryId[] = ['music', 'news', 'art'];

/** An id from a vocabulary newer than this build — the shape the server can send. */
const UNKNOWN_ID = 'quantum_basket_weaving';

describe('the vocabulary this build was compiled against', () => {
  it('is the 46-id set, every one of which has a non-empty English label', () => {
    // A vacuity floor for every other test in the file: they all draw ids from
    // this vocabulary, so a truncated or empty one would let them pass while
    // asserting nothing.
    expect(ACCOUNT_CATEGORY_IDS).toHaveLength(46);
    expect(Object.keys(ACCOUNT_CATEGORY_ENGLISH_LABELS)).toHaveLength(46);

    for (const id of ACCOUNT_CATEGORY_IDS) {
      expect(ACCOUNT_CATEGORY_ENGLISH_LABELS[id]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('names every id it can also OFFER, so a picker never lists a nameless row', () => {
    for (const id of SELECTABLE_ACCOUNT_CATEGORY_IDS) {
      expect(isKnownAccountCategoryId(id)).toBe(true);
    }
  });

  it('separates "cannot be offered again" from "cannot be named"', () => {
    // Nameability is driven by the WHOLE vocabulary, never by what a picker may
    // still offer — which is what keeps a retired id rendering on the account
    // that already carries it.
    //
    // NOTE ON VACUITY: `RETIRED_ACCOUNT_CATEGORY_IDS` is empty today, so the two
    // sets coincide and no fixture can exercise a genuinely retired id. What is
    // asserted here is the containment that makes the distinction hold WHEN one
    // is retired — a retired id leaves the selectable set and stays in the
    // vocabulary, so it keeps its label.
    expect(SELECTABLE_ACCOUNT_CATEGORY_IDS.length).toBeLessThanOrEqual(
      ACCOUNT_CATEGORY_IDS.length,
    );
    for (const id of SELECTABLE_ACCOUNT_CATEGORY_IDS) {
      expect(ACCOUNT_CATEGORY_IDS).toContain(id);
    }
  });

  it('rejects an id it has never heard of', () => {
    expect(isKnownAccountCategoryId(UNKNOWN_ID)).toBe(false);
    expect(isKnownAccountCategoryId('')).toBe(false);
    // Guards against a plain-object lookup standing in for the set — every
    // object inherits these, so `'toString' in labels` is true.
    expect(isKnownAccountCategoryId('toString')).toBe(false);
    expect(isKnownAccountCategoryId('constructor')).toBe(false);
  });
});

describe('primaryAccountCategoryId', () => {
  it('is element 0 — not the alphabetically first, and not the last', () => {
    expect(primaryAccountCategoryId(STORED)).toBe('music');
  });

  it('is null when there is nothing stored', () => {
    expect(primaryAccountCategoryId([])).toBeNull();
    expect(primaryAccountCategoryId(undefined)).toBeNull();
  });

  it('is null — NOT the second element — when the primary cannot be named', () => {
    // The line means "this account's primary category". Answering with a
    // category the account merely also has would state something false, so an
    // unnameable primary suppresses the line rather than sliding down the list.
    expect(primaryAccountCategoryId([UNKNOWN_ID, 'news', 'art'])).toBeNull();
  });

  it('still answers when a LATER id cannot be named', () => {
    expect(primaryAccountCategoryId(['music', UNKNOWN_ID])).toBe('music');
  });
});

describe('nameableAccountCategoryIds', () => {
  it('keeps the stored order rather than sorting it', () => {
    expect(nameableAccountCategoryIds(STORED)).toEqual(['music', 'news', 'art']);
  });

  it('drops only the ids it cannot name, leaving the rest in order', () => {
    expect(nameableAccountCategoryIds(['music', UNKNOWN_ID, 'news'])).toEqual(['music', 'news']);
  });

  it('is empty for an absent, empty or wholly unnameable list', () => {
    expect(nameableAccountCategoryIds(undefined)).toEqual([]);
    expect(nameableAccountCategoryIds([])).toEqual([]);
    expect(nameableAccountCategoryIds([UNKNOWN_ID])).toEqual([]);
  });

  it('does not mutate the list it was given', () => {
    const input: AccountCategoryId[] = ['music', 'news', 'art'];
    nameableAccountCategoryIds(input);
    expect(input).toEqual(['music', 'news', 'art']);
  });
});

describe('toggleAccountCategory', () => {
  it('adds a new id at the END, so choosing another never demotes the primary', () => {
    expect(toggleAccountCategory(['music', 'news'], 'art', MAX_ACCOUNT_CATEGORIES)).toEqual([
      'music',
      'news',
      'art',
    ]);
  });

  it('removes an id that is already chosen, leaving the rest in order', () => {
    expect(toggleAccountCategory(STORED, 'news', MAX_ACCOUNT_CATEGORIES)).toEqual(['music', 'art']);
  });

  it('promotes the second to primary when the primary itself is removed', () => {
    expect(toggleAccountCategory(STORED, 'music', MAX_ACCOUNT_CATEGORIES)).toEqual(['news', 'art']);
  });

  it('refuses to exceed the cap', () => {
    const atCap: AccountCategoryId[] = ['music', 'news', 'art', 'food'];
    expect(atCap).toHaveLength(MAX_ACCOUNT_CATEGORIES);
    expect(toggleAccountCategory(atCap, 'travel', MAX_ACCOUNT_CATEGORIES)).toEqual(atCap);
  });

  it('still REMOVES at the cap — the limit is on adding, not on editing', () => {
    const atCap: AccountCategoryId[] = ['music', 'news', 'art', 'food'];
    expect(toggleAccountCategory(atCap, 'news', MAX_ACCOUNT_CATEGORIES)).toEqual([
      'music',
      'art',
      'food',
    ]);
  });

  it('never mutates its input', () => {
    const input: AccountCategoryId[] = ['music', 'news'];
    toggleAccountCategory(input, 'art', MAX_ACCOUNT_CATEGORIES);
    toggleAccountCategory(input, 'music', MAX_ACCOUNT_CATEGORIES);
    expect(input).toEqual(['music', 'news']);
  });
});

describe('promoteAccountCategoryToPrimary', () => {
  it('moves the chosen id to the front', () => {
    expect(promoteAccountCategoryToPrimary(STORED, 'art')).toEqual(['art', 'music', 'news']);
  });

  it('leaves the others in their relative order rather than reshuffling them', () => {
    // 'music' and 'news' were 1st and 2nd and stay in that sequence behind 'art'
    // — a swap-with-index-0 implementation would answer ['art','news','music'].
    expect(promoteAccountCategoryToPrimary(STORED, 'art')).not.toEqual([
      'art',
      'news',
      'music',
    ]);
  });

  it('is a no-op for an id that is already primary', () => {
    expect(promoteAccountCategoryToPrimary(STORED, 'music')).toEqual(['music', 'news', 'art']);
  });

  it('does not INSERT an id that was never chosen', () => {
    expect(promoteAccountCategoryToPrimary(STORED, 'travel')).toEqual(['music', 'news', 'art']);
  });

  it('never mutates its input', () => {
    const input: AccountCategoryId[] = ['music', 'news', 'art'];
    promoteAccountCategoryToPrimary(input, 'art');
    expect(input).toEqual(['music', 'news', 'art']);
  });
});

describe('accountCategoriesEqual', () => {
  it('reports a RE-ORDERING as a change — the primary control makes no other kind', () => {
    expect(accountCategoriesEqual(['music', 'news'], ['news', 'music'])).toBe(false);
  });

  it('matches an identical list', () => {
    expect(accountCategoriesEqual(STORED, ['music', 'news', 'art'])).toBe(true);
    expect(accountCategoriesEqual([], [])).toBe(true);
  });

  it('reports added and removed entries', () => {
    expect(accountCategoriesEqual(['music'], ['music', 'news'])).toBe(false);
    expect(accountCategoriesEqual(['music', 'news'], ['music'])).toBe(false);
  });
});
