import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Platform, Text, TextInput, TouchableOpacity, View, ViewStyle } from 'react-native'
import { colors } from '../styles/colors'

const debounce = (func: Function, wait: number) => {
    let timeout: NodeJS.Timeout;
    return function executedFunction(...args: any[]) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

export const SearchBar = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const router = useRouter();
    const { t } = useTranslation();

    const handleSearch = useCallback(
        debounce(async (query: string) => {
            if (!query.trim()) return;
            setIsLoading(true);
            try {
                await router.push(`/search/${encodeURIComponent(query)}`);
            } finally {
                setIsLoading(false);
            }
        }, 300),
        []
    );

    const handleSearchChange = (query: string) => {
        setSearchQuery(query);
        handleSearch(query);
    };

    return (
        <View style={{
            backgroundColor: colors.COLOR_BACKGROUND,
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            ...Platform.select({
                web: { position: 'sticky' },
            }),
            marginTop: 20,
            top: 0,
            zIndex: 1000,
            paddingVertical: 4,
            width: '100%',
            gap: 10,
        } as ViewStyle}>
            <View style={{
                backgroundColor: colors.primaryLight,
                borderRadius: 100,
                height: 45,
                flexDirection: 'row',
                justifyContent: 'flex-start',
                alignItems: 'center',
                paddingStart: 15,
                flex: 1,
                width: '100%',
            }}>
                {isLoading ? (
                    <ActivityIndicator size="small" color={colors.COLOR_BLACK_LIGHT_4} />
                ) : (
                    <Ionicons name="search" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                )}
                <TextInput
                    style={{
                        fontSize: 16,
                        color: colors.COLOR_BLACK_LIGHT_4,
                        marginHorizontal: 17,
                        flex: 1,
                    }}
                    placeholder={t("Search Mention")}
                    value={searchQuery}
                    onChangeText={handleSearchChange}
                    returnKeyType="search"
                    onSubmitEditing={() => handleSearch(searchQuery)}
                />
                <TouchableOpacity
                    onPress={() => setShowFilters(!showFilters)}
                    style={{
                        padding: 10,
                        marginRight: 5,
                    }}
                >
                    <Ionicons name="options-outline" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                </TouchableOpacity>
            </View>

            {showFilters && (
                <View style={{
                    backgroundColor: colors.primaryLight,
                    width: '100%',
                    padding: 15,
                    borderRadius: 15,
                    marginTop: 5,
                }}>
                    <Text style={{ fontWeight: 'bold', marginBottom: 10 }}>
                        {t("Filter by")}
                    </Text>

                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        <FilterPill label="People" />
                        <FilterPill label="Hashtags" />
                        <FilterPill label="Latest" />
                        <FilterPill label="Photos" />
                        <FilterPill label="Videos" />
                        <FilterPill label="Verified" />
                    </View>

                    <TouchableOpacity
                        style={{
                            backgroundColor: colors.primaryColor,
                            padding: 10,
                            borderRadius: 20,
                            alignItems: 'center',
                            marginTop: 15,
                        }}
                        onPress={() => {
                            setShowFilters(false);
                            router.push('/search/advanced');
                        }}
                    >
                        <Text style={{ color: 'white', fontWeight: '600' }}>
                            {t("Advanced Search")}
                        </Text>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    )
}

const FilterPill = ({ label }: { label: string }) => {
    const [isSelected, setIsSelected] = useState(false);

    return (
        <TouchableOpacity
            style={{
                paddingVertical: 6,
                paddingHorizontal: 12,
                borderRadius: 20,
                backgroundColor: isSelected ? colors.primaryColor : '#f0f0f0',
                borderWidth: isSelected ? 0 : 1,
                borderColor: '#e0e0e0',
            }}
            onPress={() => setIsSelected(!isSelected)}
        >
            <Text style={{
                color: isSelected ? 'white' : colors.COLOR_BLACK_LIGHT_4,
                fontSize: 14,
                fontWeight: isSelected ? '600' : 'normal',
            }}>
                {label}
            </Text>
        </TouchableOpacity>
    );
};
