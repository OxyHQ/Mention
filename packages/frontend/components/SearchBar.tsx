import { useRouter } from '@/lib/navigation/router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search as LSearch, toElement, VStack } from '@oxy.so/bloom-language';

/**
 * Right-rail search box — the same Bloom `Search` field the search screen uses, so
 * both entry points share one input chrome (pill radius, magnifier, clear button,
 * focus/hover states) instead of a look-alike pressable.
 *
 * Submitting hands the term to the search screen through `?q=`, which that screen
 * syncs into its own state — so the rail seeds a search from any route, and
 * submitting again while already on `/search` re-runs it.
 *
 * WEB pins the bar with `.sticky('top')` (react-native-web resolves `position:
 * sticky`); on native the bar simply sits in flow. The
 * rail holds its children with margins rather than a column `gap`, so the bar
 * carries its own bottom margin — wrapping it in a spacing `View` instead would
 * make that wrapper the sticky containing block and leave it nothing to travel.
 */
export const SearchBar = () => {
  const router = useRouter();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  // Same declarative `{pathname, params}` navigation the `/search/<query>` deep
  // link uses (`app/(app)/search/[query].tsx`) — expo-router owns the encoding.
  // A blank submit goes to the bare route rather than a trailing `?q=`.
  const handleSubmit = () => {
    const term = query.trim();
    router.push(term ? { pathname: '/search', params: { q: term } } : '/search');
  };

  return toElement(
    VStack(
      LSearch([query, setQuery])
        .label(t('searchBar.placeholder'))
        .onClearText(() => setQuery(''))
        .onSubmit(handleSubmit),
    )
      .frame({ width: 'full' })
      // The sticky bar has to be opaque in the RAIL's colour, and the rail is not
      // the centre panel — it sits on the shell background. `bg-card` named the
      // panel's colour from outside the panel; this asks the surface it is
      // actually on.
      .background('surfaceFill')
      .sticky('top')
      .margin('bottom', 'lg')
      .zIndex('floating'),
  );
};
