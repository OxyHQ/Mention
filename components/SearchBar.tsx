import React, { useState, useCallback } from 'react'
import { View, TextInput, Platform, ViewStyle, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '../styles/colors'
import { useRouter } from 'expo-router'
import api from '@/utils/api'

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
    const router = useRouter();

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
            flexDirection: 'row',
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
                    placeholder="Search Mention"
                    value={searchQuery}
                    onChangeText={handleSearchChange}
                    returnKeyType="search"
                    onSubmitEditing={() => handleSearch(searchQuery)}
                />
            </View>
        </View>
    )
}
