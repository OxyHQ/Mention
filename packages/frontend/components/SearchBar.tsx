import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Platform, StyleSheet, Text, TextInput, TouchableOpacity, View, ViewStyle } from 'react-native'
import { Loading } from '@/components/ui/Loading'
import { useTheme } from '@/hooks/useTheme'
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

type FilterType = 'people' | 'hashtags' | 'latest' | 'photos' | 'videos';

const FILTER_OPTIONS: { id: FilterType; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { id: 'people', label: 'People', icon: 'people-outline' },
    { id: 'hashtags', label: 'Hashtags', icon: 'pricetag-outline' },
    { id: 'latest', label: 'Latest', icon: 'time-outline' },
    { id: 'photos', label: 'Photos', icon: 'image-outline' },
    { id: 'videos', label: 'Videos', icon: 'videocam-outline' },
];

export const SearchBar = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const [activeFilters, setActiveFilters] = useState<Set<FilterType>>(new Set());
    const router = useRouter();
    const { t } = useTranslation();
    const theme = useTheme();

    const handleSearch = useCallback(
        debounce(async (query: string) => {
            if (!query.trim()) return;
            setIsLoading(true);
            try {
                const filterParam = activeFilters.size > 0
                    ? `&filter=${Array.from(activeFilters).join(',')}`
                    : '';
                await router.push(`/search?q=${encodeURIComponent(query)}${filterParam}`);
            } finally {
                setIsLoading(false);
            }
        }, 300),
        [activeFilters]
    );

    const handleSearchChange = (query: string) => {
        setSearchQuery(query);
        handleSearch(query);
    };

    const toggleFilter = (filter: FilterType) => {
        setActiveFilters(prev => {
            const next = new Set(prev);
            if (next.has(filter)) {
                next.delete(filter);
            } else {
                next.add(filter);
            }
            return next;
        });
    };

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
            <View style={[styles.searchInputContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                {isLoading ? (
                    <Loading variant="inline" size="small" style={styles.searchIconWrapper} />
                ) : (
                    <View style={styles.searchIconWrapper}>
                        <Search size={18} color={theme.colors.textSecondary} />
                    </View>
                )}
                <TextInput
                    style={[styles.input, { color: theme.colors.text }]}
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
                <TouchableOpacity
                    onPress={() => setShowFilters(!showFilters)}
                    style={[
                        styles.filterToggle,
                        activeFilters.size > 0 && { backgroundColor: theme.colors.primaryLight },
                    ]}
                >
                    <Ionicons
                        name="options-outline"
                        size={18}
                        color={activeFilters.size > 0 ? theme.colors.primary : theme.colors.textSecondary}
                    />
                </TouchableOpacity>
            </View>

            {showFilters && (
                <View style={[styles.filtersDropdown, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    <Text style={[styles.filterLabel, { color: theme.colors.textSecondary }]}>
                        {t("Filter by")}
                    </Text>
                    <View style={styles.filterPillsRow}>
                        {FILTER_OPTIONS.map(option => {
                            const isActive = activeFilters.has(option.id);
                            return (
                                <TouchableOpacity
                                    key={option.id}
                                    style={[
                                        styles.filterPill,
                                        {
                                            backgroundColor: isActive ? theme.colors.primary : theme.colors.backgroundSecondary,
                                            borderColor: isActive ? theme.colors.primary : theme.colors.border,
                                        },
                                    ]}
                                    onPress={() => toggleFilter(option.id)}
                                >
                                    <Ionicons
                                        name={option.icon}
                                        size={14}
                                        color={isActive ? '#fff' : theme.colors.text}
                                    />
                                    <Text style={[
                                        styles.filterPillText,
                                        { color: isActive ? '#fff' : theme.colors.text },
                                    ]}>
                                        {t(option.label)}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>
            )}
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
        marginTop: SPACING.lg,
        top: 0,
        zIndex: 1000,
        paddingVertical: SPACING.xs,
        width: '100%',
        gap: SPACING.sm,
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
    },
    clearBtn: {
        padding: SPACING.xs,
    },
    filterToggle: {
        padding: SPACING.sm,
        borderRadius: 100,
    },
    filtersDropdown: {
        width: '100%',
        padding: SPACING.md,
        borderRadius: SPACING.md,
        borderWidth: 1,
    },
    filterLabel: {
        fontSize: FONT_SIZES.sm,
        fontWeight: '600',
        marginBottom: SPACING.sm,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    filterPillsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: SPACING.sm,
    },
    filterPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: SPACING.sm,
        paddingHorizontal: SPACING.md,
        borderRadius: 20,
        borderWidth: 1,
    },
    filterPillText: {
        fontSize: FONT_SIZES.base,
        fontWeight: '500',
    },
});
