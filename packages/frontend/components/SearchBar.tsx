import { useRouter } from 'expo-router'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Text, TouchableOpacity, View } from 'react-native'
import { Search } from '@/assets/icons/search-icon'

/**
 * Right-rail entry point into the search screen.
 *
 * WEB pins the bar with `web:sticky` (react-native-web resolves `position:
 * sticky`); on native the class is inert and the bar simply sits in flow.
 */
export const SearchBar = () => {
    const router = useRouter();
    const { t } = useTranslation();

    return (
        <View className="bg-background w-full items-center justify-center z-[1000] web:sticky web:top-0">
            <TouchableOpacity
                className="bg-muted w-full h-11 flex-row items-center rounded-full px-3 web:cursor-pointer"
                onPress={() => router.push('/search')}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={t('Search Mention')}
            >
                <View className="w-5 h-5 items-center justify-center">
                    <Search size={18} className="text-muted-foreground" />
                </View>
                <Text className="text-muted-foreground text-base flex-1 mx-3" numberOfLines={1}>
                    {t('Search Mention')}
                </Text>
            </TouchableOpacity>
        </View>
    );
};
