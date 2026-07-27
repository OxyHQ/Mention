import { useRouter } from 'expo-router'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { Search } from '@oxyhq/bloom/search'

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
 * sticky`); on native the class is inert and the bar simply sits in flow.
 */
export const SearchBar = () => {
    const router = useRouter();
    const { t } = useTranslation();
    const [query, setQuery] = useState('');

    const handleSubmit = useCallback(() => {
        const term = query.trim();
        router.push(term ? `/search?q=${encodeURIComponent(term)}` : '/search');
    }, [query, router]);

    const handleClear = useCallback(() => setQuery(''), []);

    return (
        <View className="bg-background w-full z-[1000] web:sticky web:top-0">
            <Search
                label={t('Search Mention')}
                value={query}
                onChangeText={setQuery}
                onClearText={handleClear}
                onSubmitEditing={handleSubmit}
            />
        </View>
    );
};
