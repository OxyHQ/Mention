import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Platform, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native'
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme'
import { Search } from '@/assets/icons/search-icon'
import { SPACING } from '@/styles/spacing'
import { FONT_SIZES } from '@/styles/typography'

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
    const { t } = useTranslation();
    const theme = useTheme();

    const handleSearch = useCallback(
        debounce(async (query: string) => {
            if (!query.trim()) return;
            setIsLoading(true);
            try {
                await router.push(`/search?q=${encodeURIComponent(query)}`);
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
        <View className="bg-background" style={styles.container}>
            <View className="bg-muted" style={styles.searchInputContainer}>
                {isLoading ? (
                    <Loading variant="inline" size="small" style={styles.searchIconWrapper} />
                ) : (
                    <View style={styles.searchIconWrapper}>
                        <Search size={18} className="text-muted-foreground" />
                    </View>
                )}
                <TextInput
                    className="text-foreground"
                    style={styles.input}
                    placeholder={t("Search Mention")}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={searchQuery}
                    onChangeText={handleSearchChange}
                    returnKeyType="search"
                    onSubmitEditing={() => handleSearch(searchQuery)}
                />
                {searchQuery.length > 0 && (
                    <TouchableOpacity
                        onPress={() => {
                            setSearchQuery('');
                        }}
                        style={styles.clearBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        ...Platform.select({
            web: { position: 'sticky' as any },
        }),
        top: 0,
        zIndex: 1000,
        width: '100%',
    },
    searchInputContainer: {
        borderRadius: 100,
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SPACING.md,
        width: '100%',
    },
    searchIconWrapper: {
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    input: {
        fontSize: FONT_SIZES.lg,
        marginHorizontal: SPACING.md,
        flex: 1,
        ...Platform.select({
            web: {
                outlineStyle: 'none',
                outlineWidth: 0,
            } as any,
        }),
    },
    clearBtn: {
        padding: SPACING.xs,
    },
});
