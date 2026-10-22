import {
  ACCOUNT_CATEGORY_IDS,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  type AccountCategoryId,
} from '@oxy.so/contracts';

import {
  ACCOUNT_CATEGORY_ENGLISH_LABELS,
  isKnownAccountCategoryId,
  nameableAccountCategoryIds,
  primaryAccountCategoryId,
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
    expect(SELECTABLE_ACCOUNT_CATEGORY_IDS.length).toBeLessThanOrEqual(ACCOUNT_CATEGORY_IDS.length);
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
