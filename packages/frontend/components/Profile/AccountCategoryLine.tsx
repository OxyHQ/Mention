import React, { memo } from 'react';
import { Text } from 'react-native';

import { useAccountCategoryLabel } from '@/hooks/useAccountCategoryLabel';
import { primaryAccountCategoryId } from '@/utils/accountCategories';

interface AccountCategoryLineProps {
  /** The account's categories, in stored order — element 0 is the primary. */
  accountCategories?: readonly string[];
  /** `center` for the channel masthead, `start` for the person-family header. */
  align: 'center' | 'start';
}

/**
 * An account's PRIMARY category, under its name — plain muted text, the way
 * Instagram names what a professional account is.
 *
 * Deliberately NOT a chip: a bordered pill reads as something to tap, and this
 * is a fact about the account rather than a filter or a link. Deliberately ONE
 * category, not the list: the header's job is a name, a handle and what this
 * account IS, and four labels stacked under a name flatten exactly the
 * hierarchy the centred masthead exists to create. The rest of the list is on
 * the about screen, which is the surface for "everything about this account".
 *
 * It renders NOTHING — not an empty line, not a spacer — when there is no
 * primary to name, so the margin below travels with the text rather than being
 * left behind as a gap. That covers three cases at once: an account with no
 * categories, an account whose categories this build is too old to know, and
 * the moment before the profile has loaded.
 *
 * The margins live here, in two complete literal class strings, rather than
 * being composed from a template or passed in: NativeWind extracts classes
 * statically, so a concatenated `className` can silently produce no styling at
 * all. `UserName` picks its own centred/leading classes the same way.
 */
export const AccountCategoryLine = memo(function AccountCategoryLine({
  accountCategories,
  align,
}: AccountCategoryLineProps) {
  const categoryLabel = useAccountCategoryLabel();

  // Never falls through to a later category: see `primaryAccountCategoryId`.
  const primary = primaryAccountCategoryId(accountCategories);
  if (primary === null) return null;

  return (
    <Text
      className={
        align === 'center'
          ? 'text-muted-foreground text-[13px] text-center mt-1'
          : 'text-muted-foreground text-[13px] mb-3'
      }
      numberOfLines={1}>
      {categoryLabel(primary)}
    </Text>
  );
});
