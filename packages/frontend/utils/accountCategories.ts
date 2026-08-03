import { ACCOUNT_CATEGORY_IDS, type AccountCategoryId } from '@oxyhq/contracts';

/**
 * An account's categories — what a channel, organization, project or bot IS.
 *
 * The whole model rests on ONE fact, and every function here exists to keep it:
 * the stored value is an ORDERED list of ids, and **element 0 is the primary
 * category**. There is deliberately no sibling `primaryCategory` field at Oxy,
 * because two representations of one fact can disagree — so nothing here may
 * sort, and nothing may reorder a list on its way to a renderer.
 *
 * The values are IDS, never labels, which is what lets the READER's language win
 * over the writer's: `useAccountCategoryLabel` resolves each id through the
 * `accounts.accountCategory.<id>` key.
 */

/**
 * The ids this build can NAME.
 *
 * A stored id can legitimately be one this build has never heard of — the
 * vocabulary lives at Oxy and grows there, so an older client will meet a newer
 * id, and the account is not wrong for having it. The set is what separates
 * "renders as its label" from "cannot be named here", and it is a `Set` because
 * every list read below tests membership per element.
 *
 * A RETIRED id is still a known one: withdrawal removes an id from
 * `SELECTABLE_ACCOUNT_CATEGORY_IDS` — so no picker offers it again — but leaves
 * it in `ACCOUNT_CATEGORY_IDS`, so an account that already carries one keeps
 * displaying it normally. Retired and unknown are therefore NOT the same case,
 * and only the second one has no label.
 */
const KNOWN_ACCOUNT_CATEGORY_IDS: ReadonlySet<string> = new Set(ACCOUNT_CATEGORY_IDS);

/** Whether this build can put a label on `id`. */
export function isKnownAccountCategoryId(id: string): id is AccountCategoryId {
  return KNOWN_ACCOUNT_CATEGORY_IDS.has(id);
}

/**
 * The English label for every id in the vocabulary.
 *
 * Typed as a total `Record`, so adding an id at Oxy fails THIS build until
 * somebody writes its English — the alternative is an id that silently renders
 * as nothing on every surface, in every language, with no error anywhere.
 *
 * It is the `defaultValue` behind each `t()` call rather than a second catalog:
 * without one, a missing `en.json` entry makes i18next echo the KEY, so a
 * profile would read "accounts.accountCategory.news" — worse than the raw slug
 * this whole indirection exists to avoid.
 */
export const ACCOUNT_CATEGORY_ENGLISH_LABELS: Record<AccountCategoryId, string> = {
  news: 'News',
  politics: 'Politics',
  business: 'Business',
  startup: 'Startup',
  finance: 'Finance',
  crypto: 'Crypto',
  marketplace: 'Marketplace',
  retail: 'Retail',
  real_estate: 'Real estate',
  agency: 'Agency',
  landlord: 'Landlord',
  cooperative: 'Cooperative',
  architecture: 'Architecture',
  technology: 'Technology',
  software: 'Software',
  ai: 'AI',
  security: 'Security',
  automation: 'Automation',
  science: 'Science',
  education: 'Education',
  books: 'Books',
  health: 'Health',
  fitness: 'Fitness',
  sports: 'Sports',
  gaming: 'Gaming',
  music: 'Music',
  film: 'Film',
  podcast: 'Podcast',
  art: 'Art',
  photography: 'Photography',
  comedy: 'Comedy',
  food: 'Food',
  travel: 'Travel',
  fashion: 'Fashion',
  home_garden: 'Home & garden',
  diy: 'DIY',
  automotive: 'Automotive',
  animals: 'Animals',
  family: 'Family',
  nonprofit: 'Nonprofit',
  government: 'Government',
  community: 'Community',
  activism: 'Activism',
  environment: 'Environment',
  religion: 'Religion',
  other: 'Other',
};

/**
 * The PRIMARY category to display, or `null` when there is none to name.
 *
 * When element 0 is an id this build cannot name, the answer is `null` — it is
 * NOT the next element. The profile line means "this account's primary
 * category", so filling it with a category that is merely one the account also
 * has would state something false, quietly, and only on clients old enough to
 * hit it. Showing nothing is incomplete; showing the second is wrong.
 */
export function primaryAccountCategoryId(
  ids: readonly string[] | undefined,
): AccountCategoryId | null {
  const primary = ids?.[0];
  return primary !== undefined && isKnownAccountCategoryId(primary) ? primary : null;
}

/**
 * Every stored id this build can name, in STORED ORDER.
 *
 * Filters, never sorts: the order carries the primary, so re-ordering here would
 * destroy the one piece of information the list encodes.
 */
export function nameableAccountCategoryIds(
  ids: readonly string[] | undefined,
): AccountCategoryId[] {
  return (ids ?? []).filter(isKnownAccountCategoryId);
}

/**
 * `id` added to (or removed from) `current`, for a picker.
 *
 * A newly chosen id joins at the END rather than the front: choosing a second
 * category must not silently demote the primary, which is a separate decision
 * with its own control. At the cap, `current` is returned UNCHANGED — the caller
 * disables the row, and this is the second half of that rule so a race or a
 * stale render cannot exceed the cap.
 */
export function toggleAccountCategory(
  current: readonly AccountCategoryId[],
  id: AccountCategoryId,
  max: number,
): AccountCategoryId[] {
  if (current.includes(id)) return current.filter((entry) => entry !== id);
  if (current.length >= max) return [...current];
  return [...current, id];
}

/**
 * `current` with `id` moved to the front — which IS "make this the primary",
 * because the primary is the first element and nothing else records it.
 *
 * The rest keep their relative order, so promoting one category is not also a
 * re-shuffle of the others. An id that is not in the list is not inserted:
 * promoting something unselected would be a selection, and the cap is checked by
 * the selection path.
 */
export function promoteAccountCategoryToPrimary(
  current: readonly AccountCategoryId[],
  id: AccountCategoryId,
): AccountCategoryId[] {
  if (!current.includes(id)) return [...current];
  return [id, ...current.filter((entry) => entry !== id)];
}

/**
 * Whether two lists are the same — ORDER INCLUDED.
 *
 * Order-sensitive on purpose: promoting a category changes nothing but the
 * order, so an order-blind comparison would report a re-ordering as "no
 * changes" and leave the save button disabled on the one edit the primary
 * control exists to make.
 */
export function accountCategoriesEqual(
  a: readonly AccountCategoryId[],
  b: readonly AccountCategoryId[],
): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}
