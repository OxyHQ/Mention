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
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { HeaderIconButton } from "@/components/HeaderIconButton";
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
            <SafeAreaView
                style={[styles.container, { backgroundColor: theme.colors.background }]}
            >
                <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
                    <HeaderIconButton onPress={onClose} style={styles.closeButton}>
                        <CloseIcon size={20} color={theme.colors.text} />
                    </HeaderIconButton>
                    <Text style={[styles.headerTitle, { color: theme.colors.text }, { pointerEvents: 'none' }]}>
                        {t("compose.event.editorTitle", { defaultValue: "Create event" })}
                    </Text>
                    <TouchableOpacity
                        onPress={onSave}
                        style={[styles.saveButton, { backgroundColor: theme.colors.primary }]}
                        activeOpacity={0.85}
                    >
                        <Text style={[styles.saveText, { color: theme.colors.card }]}>
                            {t("common.save")}
                        </Text>
                    </TouchableOpacity>
                </View>

                <KeyboardAvoidingView
                    style={{ flex: 1 }}
                    behavior={Platform.OS === "ios" ? "padding" : undefined}
                    keyboardVerticalOffset={Platform.OS === "ios" ? 24 : 0}
                >
                    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                        <TextInput
                            style={[
                                styles.nameInput,
                                {
                                    color: theme.colors.text,
                                    borderColor: theme.colors.border,
                                    backgroundColor: theme.colors.backgroundSecondary,
                                },
                            ]}
                            placeholder={t("compose.event.namePlaceholder", {
                                defaultValue: "Event name",
                            })}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={name}
                            onChangeText={onNameChange}
                            maxLength={100}
                        />

                        <View style={styles.dateTimeSection}>
                            <TouchableOpacity
                                style={[
                                    styles.dateTimeButton,
                                    {
                                        borderColor: theme.colors.border,
                                        backgroundColor: theme.colors.backgroundSecondary,
                                    },
                                ]}
                                onPress={() => setShowDatePicker(true)}
                                activeOpacity={0.7}
                            >
                                <Text style={[styles.dateTimeLabel, { color: theme.colors.textSecondary }]}>
                                    {t("compose.event.date", { defaultValue: "Date" })}
                                </Text>
                                <Text style={[styles.dateTimeValue, { color: theme.colors.text }]}>
                                    {formatDate}
                                </Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[
                                    styles.dateTimeButton,
                                    {
                                        borderColor: theme.colors.border,
                                        backgroundColor: theme.colors.backgroundSecondary,
                                    },
                                ]}
                                onPress={() => setShowTimePicker(true)}
                                activeOpacity={0.7}
                            >
                                <Text style={[styles.dateTimeLabel, { color: theme.colors.textSecondary }]}>
                                    {t("compose.event.time", { defaultValue: "Time" })}
                                </Text>
                                <Text style={[styles.dateTimeValue, { color: theme.colors.text }]}>
                                    {formatTime}
                                </Text>
                            </TouchableOpacity>
                        </View>

                        {showDatePicker && (
                            <View style={[styles.pickerContainer, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
                                <DateTimePicker
                                    mode="single"
                                    date={eventDate}
                                    onChange={handleDateChange}
                                    styles={customStyles}
                                />
                            </View>
                        )}

                        {showTimePicker && (
                            <View style={[styles.pickerContainer, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
                                <Text style={[styles.timePickerLabel, { color: theme.colors.text }]}>
                                    {t("compose.event.selectTime", { defaultValue: "Select time" })}
                                </Text>
                                <TextInput
                                    style={[
                                        styles.timeInput,
                                        {
                                            color: theme.colors.text,
                                            borderColor: theme.colors.border,
                                            backgroundColor: theme.colors.background,
                                        },
                                    ]}
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
                            style={[
                                styles.locationInput,
                                {
                                    color: theme.colors.text,
                                    borderColor: theme.colors.border,
                                    backgroundColor: theme.colors.backgroundSecondary,
                                },
                            ]}
                            placeholder={t("compose.event.locationPlaceholder", {
                                defaultValue: "Location (optional)",
                            })}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={location}
                            onChangeText={onLocationChange}
                            maxLength={200}
                        />

                        <TextInput
                            style={[
                                styles.descriptionInput,
                                {
                                    color: theme.colors.text,
                                    borderColor: theme.colors.border,
                                    backgroundColor: theme.colors.backgroundSecondary,
                                },
                            ]}
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

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    closeButton: {
        width: 40,
        height: 40,
        justifyContent: "center",
        alignItems: "center",
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: "600",
        flex: 1,
        textAlign: "center",
    },
    saveButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 20,
    },
    saveText: {
        fontSize: 15,
        fontWeight: "600",
    },
    content: {
        padding: 16,
        gap: 16,
    },
    nameInput: {
        fontSize: 18,
        fontWeight: "600",
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        minHeight: 56,
    },
    dateTimeSection: {
        flexDirection: "row",
        gap: 12,
    },
    dateTimeButton: {
        flex: 1,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
    },
    dateTimeLabel: {
        fontSize: 12,
        marginBottom: 4,
    },
    dateTimeValue: {
        fontSize: 16,
        fontWeight: "600",
    },
    pickerContainer: {
        borderRadius: 12,
        borderWidth: 1,
        padding: 12,
        marginTop: 8,
    },
    timePickerLabel: {
        fontSize: 14,
        fontWeight: "600",
        marginBottom: 12,
    },
    timeInput: {
        fontSize: 16,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        textAlign: "center",
    },
    locationInput: {
        fontSize: 15,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        minHeight: 56,
    },
    descriptionInput: {
        fontSize: 15,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        minHeight: 120,
        textAlignVertical: "top",
    },
});

