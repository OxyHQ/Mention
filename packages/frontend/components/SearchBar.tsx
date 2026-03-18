import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Platform, StyleSheet, Text, TextInput, TouchableOpacity, View, ViewStyle } from 'react-native'
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme'
import { cn } from '@/lib/utils'
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

const FILTER_OPTION_KEYS: { id: FilterType; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { id: 'people', labelKey: 'searchBar.people', icon: 'people-outline' },
    { id: 'hashtags', labelKey: 'searchBar.hashtags', icon: 'pricetag-outline' },
    { id: 'latest', labelKey: 'searchBar.latest', icon: 'time-outline' },
    { id: 'photos', labelKey: 'searchBar.photos', icon: 'image-outline' },
    { id: 'videos', labelKey: 'searchBar.videos', icon: 'videocam-outline' },
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
                <TouchableOpacity
                    onPress={() => setShowFilters(!showFilters)}
                    className={cn(activeFilters.size > 0 && "bg-primary/10")}
                    style={styles.filterToggle}
                >
                    <Ionicons
                        name="options-outline"
                        size={18}
                        color={activeFilters.size > 0 ? theme.colors.primary : theme.colors.textSecondary}
                    />
                </TouchableOpacity>
            </View>

            {showFilters && (
                <View className="bg-card border-border" style={styles.filtersDropdown}>
                    <Text className="text-muted-foreground" style={styles.filterLabel}>
                        {t("Filter by")}
                    </Text>
                    <View style={styles.filterPillsRow}>
                        {FILTER_OPTION_KEYS.map(option => {
                            const isActive = activeFilters.has(option.id);
                            return (
                                <TouchableOpacity
                                    key={option.id}
                                    className={cn(
                                        isActive ? "bg-primary border-primary" : "bg-muted border-border",
                                    )}
                                    style={styles.filterPill}
                                    onPress={() => toggleFilter(option.id)}
                                >
                                    <Ionicons
                                        name={option.icon}
                                        size={14}
                                        color={isActive ? '#fff' : theme.colors.text}
                                    />
                                    <Text
                                        className={cn(isActive ? "text-primary-foreground" : "text-foreground")}
                                        style={styles.filterPillText}
                                    >
                                        {t(option.labelKey)}
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
