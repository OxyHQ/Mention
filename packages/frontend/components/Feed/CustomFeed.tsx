import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert } from 'react-native';
import { colors } from '@/styles/colors';
import { useFeed } from '@/hooks/useFeed';
import { useTranslation } from 'react-i18next';
import Feed from './index';

interface CustomFeedFilter {
    users: string[];
    hashtags: string[];
    keywords: string[];
    mediaOnly: boolean;
}

interface CustomFeedProps {
    initialFilters?: CustomFeedFilter;
    onFiltersChange?: (filters: CustomFeedFilter) => void;
    title?: string;
}

const CustomFeed: React.FC<CustomFeedProps> = ({
    initialFilters,
    onFiltersChange,
    title = 'Custom Feed'
}) => {
    const { t } = useTranslation();
    const [filters, setFilters] = useState<CustomFeedFilter>(
        initialFilters || {
            users: [],
            hashtags: [],
            keywords: [],
            mediaOnly: false
        }
    );

    const [showFilters, setShowFilters] = useState(false);
    const [inputText, setInputText] = useState('');
    const [inputType, setInputType] = useState<'user' | 'hashtag' | 'keyword'>('hashtag');

    // Notify parent of filter changes
    useEffect(() => {
        if (onFiltersChange) {
            onFiltersChange(filters);
        }
    }, [filters, onFiltersChange]);

    const addFilter = () => {
        if (!inputText.trim()) return;

        const text = inputText.trim();
        setFilters(prev => {
            const newFilters = { ...prev };

            switch (inputType) {
                case 'user':
                    // Remove @ if user added it
                    const username = text.startsWith('@') ? text.slice(1) : text;
                    if (!newFilters.users.includes(username)) {
                        newFilters.users = [...newFilters.users, username];
                    }
                    break;
                case 'hashtag':
                    // Remove # if user added it
                    const hashtag = text.startsWith('#') ? text.slice(1) : text;
                    if (!newFilters.hashtags.includes(hashtag)) {
                        newFilters.hashtags = [...newFilters.hashtags, hashtag];
                    }
                    break;
                case 'keyword':
                    if (!newFilters.keywords.includes(text)) {
                        newFilters.keywords = [...newFilters.keywords, text];
                    }
                    break;
            }

            return newFilters;
        });

        setInputText('');
    };

    const removeFilter = (type: 'user' | 'hashtag' | 'keyword', value: string) => {
        setFilters(prev => {
            const newFilters = { ...prev };

            switch (type) {
                case 'user':
                    newFilters.users = newFilters.users.filter(u => u !== value);
                    break;
                case 'hashtag':
                    newFilters.hashtags = newFilters.hashtags.filter(h => h !== value);
                    break;
                case 'keyword':
                    newFilters.keywords = newFilters.keywords.filter(k => k !== value);
                    break;
            }

            return newFilters;
        });
    };

    const clearAllFilters = () => {
        setFilters({
            users: [],
            hashtags: [],
            keywords: [],
            mediaOnly: false
        });
    };

    const toggleMediaOnly = () => {
        setFilters(prev => ({
            ...prev,
            mediaOnly: !prev.mediaOnly
        }));
    };

    const hasActiveFilters = () => {
        return filters.users.length > 0 ||
            filters.hashtags.length > 0 ||
            filters.keywords.length > 0 ||
            filters.mediaOnly;
    };

    const getFilterSummary = () => {
        const parts = [];
        if (filters.users.length > 0) parts.push(`${filters.users.length} user${filters.users.length !== 1 ? 's' : ''}`);
        if (filters.hashtags.length > 0) parts.push(`${filters.hashtags.length} hashtag${filters.hashtags.length !== 1 ? 's' : ''}`);
        if (filters.keywords.length > 0) parts.push(`${filters.keywords.length} keyword${filters.keywords.length !== 1 ? 's' : ''}`);
        if (filters.mediaOnly) parts.push('media only');

        return parts.length > 0 ? parts.join(', ') : 'No filters active';
    };

    const renderFilterChips = (items: string[], type: 'user' | 'hashtag' | 'keyword', prefix = '') => {
        return items.map(item => (
            <TouchableOpacity
                key={item}
                style={styles.filterChip}
                onPress={() => removeFilter(type, item)}
            >
                <Text style={styles.filterChipText}>
                    {prefix}{item} ✕
                </Text>
            </TouchableOpacity>
        ));
    };

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <Text style={styles.title}>{title}</Text>
                <View style={styles.headerActions}>
                    <TouchableOpacity
                        style={styles.filterButton}
                        onPress={() => setShowFilters(!showFilters)}
                    >
                        <Text style={styles.filterButtonText}>
                            🔧 {showFilters ? 'Hide' : 'Show'} Filters
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Filter Summary */}
            <View style={styles.summaryContainer}>
                <Text style={styles.summaryText}>{getFilterSummary()}</Text>
                {hasActiveFilters() && (
                    <TouchableOpacity onPress={clearAllFilters} style={styles.clearButton}>
                        <Text style={styles.clearButtonText}>Clear All</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* Filter Controls */}
            {showFilters && (
                <View style={styles.filtersContainer}>
                    {/* Add Filter Input */}
                    <View style={styles.inputContainer}>
                        <View style={styles.inputTypeSelector}>
                            {(['hashtag', 'user', 'keyword'] as const).map(type => (
                                <TouchableOpacity
                                    key={type}
                                    style={[
                                        styles.inputTypeButton,
                                        inputType === type && styles.inputTypeButtonActive
                                    ]}
                                    onPress={() => setInputType(type)}
                                >
                                    <Text style={[
                                        styles.inputTypeButtonText,
                                        inputType === type && styles.inputTypeButtonTextActive
                                    ]}>
                                        {type === 'hashtag' ? '#' : type === 'user' ? '@' : '🔍'} {type}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <View style={styles.inputRow}>
                            <TextInput
                                style={styles.input}
                                value={inputText}
                                onChangeText={setInputText}
                                placeholder={`Add ${inputType}...`}
                                onSubmitEditing={addFilter}
                                returnKeyType="done"
                            />
                            <TouchableOpacity style={styles.addButton} onPress={addFilter}>
                                <Text style={styles.addButtonText}>Add</Text>
                            </TouchableOpacity>
                        </View>
                    </View>

                    {/* Media Only Toggle */}
                    <TouchableOpacity
                        style={[styles.toggleButton, filters.mediaOnly && styles.toggleButtonActive]}
                        onPress={toggleMediaOnly}
                    >
                        <Text style={[
                            styles.toggleButtonText,
                            filters.mediaOnly && styles.toggleButtonTextActive
                        ]}>
                            📸 Media Only
                        </Text>
                    </TouchableOpacity>

                    {/* Active Filters */}
                    {hasActiveFilters() && (
                        <ScrollView style={styles.filtersScrollView} showsVerticalScrollIndicator={false}>
                            {filters.hashtags.length > 0 && (
                                <View style={styles.filterSection}>
                                    <Text style={styles.filterSectionTitle}>Hashtags:</Text>
                                    <View style={styles.filterChipsContainer}>
                                        {renderFilterChips(filters.hashtags, 'hashtag', '#')}
                                    </View>
                                </View>
                            )}

                            {filters.users.length > 0 && (
                                <View style={styles.filterSection}>
                                    <Text style={styles.filterSectionTitle}>Users:</Text>
                                    <View style={styles.filterChipsContainer}>
                                        {renderFilterChips(filters.users, 'user', '@')}
                                    </View>
                                </View>
                            )}

                            {filters.keywords.length > 0 && (
                                <View style={styles.filterSection}>
                                    <Text style={styles.filterSectionTitle}>Keywords:</Text>
                                    <View style={styles.filterChipsContainer}>
                                        {renderFilterChips(filters.keywords, 'keyword')}
                                    </View>
                                </View>
                            )}
                        </ScrollView>
                    )}
                </View>
            )}

            {/* Feed */}
            <Feed
                type="custom"
                customOptions={{
                    users: filters.users,
                    hashtags: filters.hashtags,
                    keywords: filters.keywords,
                    mediaOnly: filters.mediaOnly
                }}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    title: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK_LIGHT_1,
    },
    headerActions: {
        flexDirection: 'row',
    },
    filterButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    filterButtonText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_2,
        fontWeight: '600',
    },
    summaryContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    summaryText: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_3,
        flex: 1,
    },
    clearButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    clearButtonText: {
        fontSize: 12,
        color: colors.primaryColor,
        fontWeight: '600',
    },
    filtersContainer: {
        backgroundColor: 'white',
        padding: 16,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    inputContainer: {
        marginBottom: 16,
    },
    inputTypeSelector: {
        flexDirection: 'row',
        marginBottom: 8,
    },
    inputTypeButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        marginRight: 8,
    },
    inputTypeButtonActive: {
        backgroundColor: colors.primaryColor,
    },
    inputTypeButtonText: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_3,
        fontWeight: '600',
    },
    inputTypeButtonTextActive: {
        color: 'white',
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    input: {
        flex: 1,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 14,
        marginRight: 8,
    },
    addButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: colors.primaryColor,
        borderRadius: 8,
    },
    addButtonText: {
        color: 'white',
        fontWeight: '600',
        fontSize: 14,
    },
    toggleButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        alignSelf: 'flex-start',
        marginBottom: 16,
    },
    toggleButtonActive: {
        backgroundColor: colors.primaryColor,
    },
    toggleButtonText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
        fontWeight: '600',
    },
    toggleButtonTextActive: {
        color: 'white',
    },
    filtersScrollView: {
        maxHeight: 200,
    },
    filterSection: {
        marginBottom: 12,
    },
    filterSectionTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_2,
        marginBottom: 8,
    },
    filterChipsContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    filterChip: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        borderRadius: 12,
        marginRight: 8,
        marginBottom: 4,
    },
    filterChipText: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_2,
    },
});

export default CustomFeed; 