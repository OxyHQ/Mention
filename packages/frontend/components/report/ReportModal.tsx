import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    ScrollView,
} from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { REPORT_CATEGORIES } from '@/services/reportService';

interface ReportModalProps {
    visible: boolean;
    onClose: () => void;
    onSubmit: (categories: string[], details?: string) => void;
}

export const ReportModal: React.FC<ReportModalProps> = ({
    visible,
    onClose,
    onSubmit,
}) => {
    const theme = useTheme();
    const { t } = useTranslation();
    const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
    const [details, setDetails] = useState('');

    if (!visible) return null;

    const toggleCategory = (categoryId: string) => {
        setSelectedCategories((prev) =>
            prev.includes(categoryId)
                ? prev.filter((id) => id !== categoryId)
                : [...prev, categoryId]
        );
    };

    const handleSubmit = () => {
        if (selectedCategories.length === 0) {
            return;
        }
        onSubmit(selectedCategories, details || undefined);
        // Reset state
        setSelectedCategories([]);
        setDetails('');
        onClose();
    };

    const handleCancel = () => {
        setSelectedCategories([]);
        setDetails('');
        onClose();
    };

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
            {/* Header */}
            <View style={[styles.header, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.border }]}>
                <TouchableOpacity
                    onPress={handleCancel}
                    style={styles.closeButton}
                    activeOpacity={0.7}
                >
                    <CloseIcon size={20} color={theme.colors.text} />
                </TouchableOpacity>
                <Text style={[styles.title, { color: theme.colors.text }]}>
                    Report Post
                </Text>
                <View style={styles.headerRight} />
            </View>

            {/* Content */}
            <ScrollView style={styles.content}>
                <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
                    Select at least one reason for reporting:
                </Text>

                {/* Categories */}
                <View style={styles.categoriesContainer}>
                    {REPORT_CATEGORIES.map((category) => {
                        const isSelected = selectedCategories.includes(category.id);
                        return (
                            <TouchableOpacity
                                key={category.id}
                                style={[
                                    styles.categoryItem,
                                    {
                                        backgroundColor: isSelected
                                            ? theme.colors.primary + '20'
                                            : theme.colors.card,
                                        borderColor: isSelected
                                            ? theme.colors.primary
                                            : theme.colors.border,
                                    },
                                ]}
                                onPress={() => toggleCategory(category.id)}
                                activeOpacity={0.7}
                            >
                                <View
                                    style={[
                                        styles.checkbox,
                                        {
                                            borderColor: isSelected
                                                ? theme.colors.primary
                                                : theme.colors.border,
                                            backgroundColor: isSelected
                                                ? theme.colors.primary
                                                : 'transparent',
                                        },
                                    ]}
                                >
                                    {isSelected && (
                                        <Text style={styles.checkmark}>✓</Text>
                                    )}
                                </View>
                                <Text
                                    style={[
                                        styles.categoryLabel,
                                        {
                                            color: isSelected
                                                ? theme.colors.text
                                                : theme.colors.textSecondary,
                                        },
                                    ]}
                                >
                                    {category.label}
                                </Text>
                            </TouchableOpacity>
                        );
                    })}
                </View>

                {/* Details Input */}
                <View style={styles.detailsContainer}>
                    <Text style={[styles.detailsLabel, { color: theme.colors.text }]}>
                        Additional details (optional)
                    </Text>
                    <TextInput
                        style={[
                            styles.detailsInput,
                            {
                                backgroundColor: theme.colors.card,
                                borderColor: theme.colors.border,
                                color: theme.colors.text,
                            },
                        ]}
                        placeholder="Provide more context..."
                        placeholderTextColor={theme.colors.textSecondary}
                        value={details}
                        onChangeText={setDetails}
                        multiline
                        maxLength={500}
                        textAlignVertical="top"
                    />
                    <Text style={[styles.charCount, { color: theme.colors.textSecondary }]}>
                        {details.length}/500
                    </Text>
                </View>
            </ScrollView>

            {/* Action Buttons */}
            <View style={[styles.footer, { borderTopColor: theme.colors.border }]}>
                <TouchableOpacity
                    style={[
                        styles.button,
                        styles.cancelButton,
                        {
                            backgroundColor: theme.colors.card,
                            borderColor: theme.colors.border,
                        },
                    ]}
                    onPress={handleCancel}
                    activeOpacity={0.7}
                >
                    <Text style={[styles.cancelButtonText, { color: theme.colors.text }]}>
                        Cancel
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={[
                        styles.button,
                        styles.submitButton,
                        {
                            backgroundColor:
                                selectedCategories.length > 0
                                    ? theme.colors.error
                                    : theme.colors.border,
                        },
                    ]}
                    onPress={handleSubmit}
                    disabled={selectedCategories.length === 0}
                    activeOpacity={0.7}
                >
                    <Text
                        style={[
                            styles.submitButtonText,
                            {
                                color:
                                    selectedCategories.length > 0
                                        ? '#FFFFFF'
                                        : theme.colors.textSecondary,
                            },
                        ]}
                    >
                        Submit Report
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        maxHeight: '90%',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        minHeight: 56,
        borderBottomWidth: 1,
    },
    title: {
        position: 'absolute',
        left: 0,
        right: 0,
        textAlign: 'center',
        fontSize: 18,
        fontWeight: '700',
        pointerEvents: 'none',
    },
    closeButton: {
        padding: 8,
        zIndex: 1,
    },
    headerRight: {
        width: 36,
        marginLeft: 'auto',
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 8,
    },
    subtitle: {
        fontSize: 15,
        lineHeight: 20,
        marginBottom: 16,
    },
    categoriesContainer: {
        gap: 8,
        marginBottom: 24,
    },
    categoryItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderRadius: 12,
        borderWidth: 1.5,
    },
    checkbox: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        marginRight: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkmark: {
        color: '#FFFFFF',
        fontSize: 14,
        fontWeight: '700',
    },
    categoryLabel: {
        fontSize: 15,
        fontWeight: '500',
    },
    detailsContainer: {
        marginBottom: 16,
    },
    detailsLabel: {
        fontSize: 15,
        fontWeight: '600',
        marginBottom: 8,
    },
    detailsInput: {
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        fontSize: 15,
        minHeight: 100,
        maxHeight: 150,
    },
    charCount: {
        fontSize: 13,
        textAlign: 'right',
        marginTop: 4,
    },
    footer: {
        flexDirection: 'row',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 16,
        paddingBottom: 20,
        borderTopWidth: 1,
    },
    button: {
        flex: 1,
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 50,
    },
    cancelButton: {
        borderWidth: 1,
    },
    submitButton: {
        // backgroundColor set inline
    },
    cancelButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    submitButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
});

export default ReportModal;
