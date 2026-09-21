import { useRouter } from 'expo-router'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { Search } from '@oxy.so/bloom/search'
import { useSurfaceFill } from '@oxy.so/bloom/styles'

/**
 * Right-rail search box — the same Bloom `Search` field the search screen uses, so
 * both entry points share one input chrome (pill radius, magnifier, clear button,
 * focus/hover states) instead of a look-alike pressable.
 *
 * Submitting hands the term to the search screen through `?q=`, which that screen
 * syncs into its own state — so the rail seeds a search from any route, and
 * submitting again while already on `/search` re-runs it.
 *
 * WEB pins the bar with `web:sticky` (react-native-web resolves `position:
 * sticky`); on native the class is inert and the bar simply sits in flow. The
 * rail holds its children with margins rather than a column `gap`, so the bar
 * carries its own bottom margin — wrapping it in a spacing `View` instead would
 * make that wrapper the sticky containing block and leave it nothing to travel.
 */
export const SearchBar = () => {
    const router = useRouter();
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    // The sticky bar has to be opaque in the RAIL's colour, and the rail is not
    // the centre panel — it sits on the shell background. `bg-card` named the
    // panel's colour from outside the panel; this asks the surface it is
    // actually on.
    const surfaceFill = useSurfaceFill();

    // Same declarative `{pathname, params}` navigation the `/search/<query>` deep
    // link uses (`app/(app)/search/[query].tsx`) — expo-router owns the encoding.
    // A blank submit goes to the bare route rather than a trailing `?q=`.
    const handleSubmit = () => {
        const term = query.trim();
        router.push(term ? { pathname: '/search', params: { q: term } } : '/search');
    };

    return (
        <View className="w-full mb-4 z-10 web:sticky web:top-0" style={{ backgroundColor: surfaceFill }}>
            <Search
                label={t('Search Mention')}
                value={query}
                onValueChange={setQuery}
                onClearText={() => setQuery('')}
                onSubmitEditing={handleSubmit}
            />
        </View>
    );
};
