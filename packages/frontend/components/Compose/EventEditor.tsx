import React from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    Modal,
    KeyboardAvoidingView,
    ScrollView,
    StyleSheet,
    Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from "react-i18next";
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from "@/assets/icons/close-icon";
import DateTimePicker, { DateType, useDefaultStyles } from "react-native-ui-datepicker";

interface EventEditorProps {
    visible: boolean;
    name: string;
    date: string; // ISO date string
    location: string;
    description: string;
    onNameChange: (name: string) => void;
    onDateChange: (date: string) => void;
    onLocationChange: (location: string) => void;
    onDescriptionChange: (description: string) => void;
    onSave: () => void;
    onClose: () => void;
}

export const EventEditor: React.FC<EventEditorProps> = ({
    visible,
    name,
    date,
    location,
    description,
    onNameChange,
    onDateChange,
    onLocationChange,
    onDescriptionChange,
    onSave,
    onClose,
}) => {
    const theme = useTheme();
    const { t } = useTranslation();
    const defaultStyles = useDefaultStyles();
    const [showDatePicker, setShowDatePicker] = React.useState(false);
    const [showTimePicker, setShowTimePicker] = React.useState(false);

    const eventDate = React.useMemo(() => {
        try {
            return date ? new Date(date) : new Date();
        } catch {
            return new Date();
        }
    }, [date]);

    const handleDateChange = React.useCallback((params: { date: DateType }) => {
        if (params.date) {
            const selectedDate = new Date(params.date as any);
            // Merge with existing time if we're just changing the date
            const currentDateTime = eventDate;
            selectedDate.setHours(currentDateTime.getHours());
            selectedDate.setMinutes(currentDateTime.getMinutes());
            selectedDate.setSeconds(currentDateTime.getSeconds());
            onDateChange(selectedDate.toISOString());
        }
        setShowDatePicker(false);
    }, [eventDate, onDateChange]);

    const handleTimeChange = React.useCallback((params: { date: DateType }) => {
        if (params.date) {
            const selectedTime = new Date(params.date as any);
            // Merge with existing date if we're just changing the time
            const currentDateTime = eventDate;
            const newDateTime = new Date(currentDateTime);
            newDateTime.setHours(selectedTime.getHours());
            newDateTime.setMinutes(selectedTime.getMinutes());
            newDateTime.setSeconds(selectedTime.getSeconds());
            onDateChange(newDateTime.toISOString());
        }
        setShowTimePicker(false);
    }, [eventDate, onDateChange]);

    const formatDate = React.useMemo(() => {
        return eventDate.toLocaleDateString('default', {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }, [eventDate]);

    const formatTime = React.useMemo(() => {
        return eventDate.toLocaleTimeString('default', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });
    }, [eventDate]);

    // Customize styles to match theme
    const customStyles = React.useMemo(() => ({
        ...defaultStyles,
        selectedDayBackground: { backgroundColor: theme.colors.primary },
        todayText: { color: theme.colors.primary },
        selectedDayText: { color: theme.colors.card },
        headerText: { color: theme.colors.text },
        weekDaysText: { color: theme.colors.textSecondary },
        calendarText: { color: theme.colors.text },
        yearContainer: { backgroundColor: theme.colors.background },
        monthContainer: { backgroundColor: theme.colors.background },
    }), [defaultStyles, theme]);

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="fullScreen"
            onRequestClose={onClose}
        >
            <SafeAreaView className="flex-1 bg-background">
                <View className="flex-row items-center justify-between px-4 py-3" style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border }}>
                    <IconButton variant="icon" onPress={onClose} className="w-10 h-10 justify-center items-center">
                        <CloseIcon size={20} className="text-foreground" />
                    </IconButton>
                    <Text className="text-lg font-semibold flex-1 text-center text-foreground">
                        {t("compose.event.editorTitle", { defaultValue: "Create event" })}
                    </Text>
                    <TouchableOpacity
                        onPress={onSave}
                        className="px-4 py-2 rounded-[20px] bg-primary"
                        activeOpacity={0.85}
                    >
                        <Text className="text-[15px] font-semibold" style={{ color: theme.colors.card }}>
                            {t("common.save")}
                        </Text>
                    </TouchableOpacity>
                </View>

                <KeyboardAvoidingView
                    className="flex-1"
                    behavior={Platform.OS === "ios" ? "padding" : undefined}
                    keyboardVerticalOffset={Platform.OS === "ios" ? 24 : 0}
                >
                    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
                        <TextInput
                            className="text-lg font-semibold p-4 rounded-xl border border-border bg-secondary text-foreground min-h-[56px]"
                            placeholder={t("compose.event.namePlaceholder", {
                                defaultValue: "Event name",
                            })}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={name}
                            onChangeText={onNameChange}
                            maxLength={100}
                        />

                        <View className="flex-row gap-3">
                            <TouchableOpacity
                                className="flex-1 p-4 rounded-xl border border-border bg-secondary"
                                onPress={() => setShowDatePicker(true)}
                                activeOpacity={0.7}
                            >
                                <Text className="text-xs text-muted-foreground mb-1">
                                    {t("compose.event.date", { defaultValue: "Date" })}
                                </Text>
                                <Text className="text-base font-semibold text-foreground">
                                    {formatDate}
                                </Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                className="flex-1 p-4 rounded-xl border border-border bg-secondary"
                                onPress={() => setShowTimePicker(true)}
                                activeOpacity={0.7}
                            >
                                <Text className="text-xs text-muted-foreground mb-1">
                                    {t("compose.event.time", { defaultValue: "Time" })}
                                </Text>
                                <Text className="text-base font-semibold text-foreground">
                                    {formatTime}
                                </Text>
                            </TouchableOpacity>
                        </View>

                        {showDatePicker && (
                            <View className="rounded-xl border border-border bg-secondary p-3 mt-2">
                                <DateTimePicker
                                    mode="single"
                                    date={eventDate}
                                    onChange={handleDateChange}
                                    styles={customStyles}
                                />
                            </View>
                        )}

                        {showTimePicker && (
                            <View className="rounded-xl border border-border bg-secondary p-3 mt-2">
                                <Text className="text-sm font-semibold text-foreground mb-3">
                                    {t("compose.event.selectTime", { defaultValue: "Select time" })}
                                </Text>
                                <TextInput
                                    className="text-base p-3 rounded-lg border border-border bg-background text-foreground text-center"
                                    placeholder="HH:MM (24h format)"
                                    placeholderTextColor={theme.colors.textSecondary}
                                    value={`${String(eventDate.getHours()).padStart(2, '0')}:${String(eventDate.getMinutes()).padStart(2, '0')}`}
                                    onChangeText={(text) => {
                                        const [hours, minutes] = text.split(':').map(Number);
                                        if (!isNaN(hours) && !isNaN(minutes) && hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
                                            const newDateTime = new Date(eventDate);
                                            newDateTime.setHours(hours);
                                            newDateTime.setMinutes(minutes);
                                            onDateChange(newDateTime.toISOString());
                                        }
                                    }}
                                    keyboardType="numeric"
                                    maxLength={5}
                                />
                            </View>
                        )}

                        <TextInput
                            className="text-[15px] p-4 rounded-xl border border-border bg-secondary text-foreground min-h-[56px]"
                            placeholder={t("compose.event.locationPlaceholder", {
                                defaultValue: "Location (optional)",
                            })}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={location}
                            onChangeText={onLocationChange}
                            maxLength={200}
                        />

                        <TextInput
                            className="text-[15px] p-4 rounded-xl border border-border bg-secondary text-foreground min-h-[120px]"
                            style={{ textAlignVertical: "top" }}
                            placeholder={t("compose.event.descriptionPlaceholder", {
                                defaultValue: "Description (optional)",
                            })}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={description}
                            onChangeText={onDescriptionChange}
                            multiline
                            numberOfLines={4}
                            maxLength={500}
                        />
                    </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        </Modal>
    );
};
