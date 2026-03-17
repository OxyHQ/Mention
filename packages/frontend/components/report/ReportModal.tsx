import React, { useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    TextInput,
    ScrollView,
} from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
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
        <View className="bg-background rounded-t-3xl" style={{ maxHeight: '90%' }}>
            {/* Header */}
            <View className="flex-row items-center px-4 py-3 border-b border-border" style={{ minHeight: 56 }}>
                <TouchableOpacity
                    onPress={handleCancel}
                    className="p-2 z-10"
                    activeOpacity={0.7}
                >
                    <CloseIcon size={20} className="text-foreground" />
                </TouchableOpacity>
                <Text
                    className="text-foreground text-lg font-bold absolute left-0 right-0 text-center"
                    style={{ pointerEvents: 'none' }}
                >
                    Report Post
                </Text>
                <View style={{ width: 36, marginLeft: 'auto' }} />
            </View>

            {/* Content */}
            <ScrollView className="px-4 pt-4 pb-2">
                <Text className="text-muted-foreground text-[15px] mb-4" style={{ lineHeight: 20 }}>
                    Select at least one reason for reporting:
                </Text>

                {/* Categories */}
                <View className="gap-2 mb-6">
                    {REPORT_CATEGORIES.map((category) => {
                        const isSelected = selectedCategories.includes(category.id);
                        return (
                            <TouchableOpacity
                                key={category.id}
                                className="flex-row items-center py-3.5 px-4 rounded-xl"
                                style={{
                                    backgroundColor: isSelected
                                        ? theme.colors.primary + '20'
                                        : theme.colors.card,
                                    borderColor: isSelected
                                        ? theme.colors.primary
                                        : theme.colors.border,
                                    borderWidth: 1.5,
                                }}
                                onPress={() => toggleCategory(category.id)}
                                activeOpacity={0.7}
                            >
                                <View
                                    className="items-center justify-center mr-3 rounded"
                                    style={{
                                        width: 20,
                                        height: 20,
                                        borderWidth: 2,
                                        borderColor: isSelected
                                            ? theme.colors.primary
                                            : theme.colors.border,
                                        backgroundColor: isSelected
                                            ? theme.colors.primary
                                            : 'transparent',
                                    }}
                                >
                                    {isSelected && (
                                        <Text className="text-white text-sm font-bold">
                                            {'\u2713'}
                                        </Text>
                                    )}
                                </View>
                                <Text
                                    className="text-[15px] font-medium"
                                    style={{
                                        color: isSelected
                                            ? theme.colors.text
                                            : theme.colors.textSecondary,
                                    }}
                                >
                                    {category.label}
                                </Text>
                            </TouchableOpacity>
                        );
                    })}
                </View>

                {/* Details Input */}
                <View className="mb-4">
                    <Text className="text-foreground text-[15px] font-semibold mb-2">
                        Additional details (optional)
                    </Text>
                    <TextInput
                        className="border border-border bg-card rounded-xl px-3.5 py-3 text-foreground text-[15px]"
                        style={{
                            minHeight: 100,
                            maxHeight: 150,
                            color: theme.colors.text,
                        }}
                        placeholder="Provide more context..."
                        placeholderTextColor={theme.colors.textSecondary}
                        value={details}
                        onChangeText={setDetails}
                        multiline
                        maxLength={500}
                        textAlignVertical="top"
                    />
                    <Text className="text-muted-foreground text-[13px] text-right mt-1">
                        {details.length}/500
                    </Text>
                </View>
            </ScrollView>

            {/* Action Buttons */}
            <View className="flex-row gap-3 px-4 py-4 pb-5 border-t border-border">
                <TouchableOpacity
                    className="flex-1 items-center justify-center rounded-xl border border-border bg-card"
                    style={{ paddingVertical: 14, minHeight: 50 }}
                    onPress={handleCancel}
                    activeOpacity={0.7}
                >
                    <Text className="text-foreground text-base font-semibold">
                        Cancel
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity
                    className="flex-1 items-center justify-center rounded-xl"
                    style={{
                        paddingVertical: 14,
                        minHeight: 50,
                        backgroundColor:
                            selectedCategories.length > 0
                                ? theme.colors.error
                                : theme.colors.border,
                    }}
                    onPress={handleSubmit}
                    disabled={selectedCategories.length === 0}
                    activeOpacity={0.7}
                >
                    <Text
                        className="text-base font-semibold"
                        style={{
                            color:
                                selectedCategories.length > 0
                                    ? '#FFFFFF'
                                    : theme.colors.textSecondary,
                        }}
                    >
                        Submit Report
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

export default ReportModal;
