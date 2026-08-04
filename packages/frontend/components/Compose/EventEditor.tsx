import React from "react";
import { View, Text, TextInput, TouchableOpacity } from "react-native";
import { Dialog } from '@oxyhq/bloom/dialog';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from "react-i18next";
import { Calendar } from "@/components/ui/Calendar";

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

/**
 * The composer's event-attachment editor.
 *
 * Renders through bloom's `Dialog` for the same reason as its sibling
 * `ArticleEditor`: a hand-rolled RN `<Modal>` opens a native window that sits
 * outside the design system's ordering, so anything opened from inside it — the
 * date calendar here, a confirm prompt — has no way to paint above it. It also
 * lets the Dialog own the safe-area insets, the keyboard avoidance, the scroll
 * container and the header/close affordance this used to rebuild by hand.
 *
 * Every event field is controlled by the composer, which owns the draft, so an
 * open/close/reopen cycle cannot lose what was typed. Only the two picker
 * toggles are local, and they live on this component rather than on the Dialog's
 * children, so they survive the same cycle too.
 */
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
    const [showDatePicker, setShowDatePicker] = React.useState(false);
    const [showTimePicker, setShowTimePicker] = React.useState(false);

    const eventDate = React.useMemo(() => {
        try {
            return date ? new Date(date) : new Date();
        } catch {
            return new Date();
        }
    }, [date]);

    const handleDateChange = React.useCallback((selectedDate: Date) => {
        // The calendar reports midnight of the tapped day; keep the time the
        // user already set on the event.
        const merged = new Date(selectedDate);
        merged.setHours(eventDate.getHours(), eventDate.getMinutes(), eventDate.getSeconds(), 0);
        onDateChange(merged.toISOString());
        setShowDatePicker(false);
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

    const saveAction = (
        <TouchableOpacity
            onPress={onSave}
            className="px-4 py-2 rounded-full bg-primary"
            activeOpacity={0.85}
            accessibilityRole="button"
        >
            <Text className="text-[15px] font-semibold" style={{ color: theme.colors.card }}>
                {t("common.save")}
            </Text>
        </TouchableOpacity>
    );

    return (
        <Dialog
            open={visible}
            onClose={onClose}
            placement={{ base: 'bottom', md: 'center' }}
            maxWidth={640}
            maxHeightRatio={0.92}
            header={{
                title: t("compose.event.editorTitle", { defaultValue: "Create event" }),
                largeTitle: false,
                right: saveAction,
            }}
            testID="eventEditorDialog"
        >
            <View className="gap-4 pb-6">
                        <TextInput
                            className="text-lg font-semibold p-4 rounded-xl border border-border bg-muted text-foreground min-h-[56px]"
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
                                className="flex-1 p-4 rounded-xl border border-border bg-muted"
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
                                className="flex-1 p-4 rounded-xl border border-border bg-muted"
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
                            <View className="rounded-xl border border-border bg-muted p-3 mt-2">
                                <Calendar value={eventDate} onChange={handleDateChange} />
                            </View>
                        )}

                        {showTimePicker && (
                            <View className="rounded-xl border border-border bg-muted p-3 mt-2">
                                <Text className="text-sm font-semibold text-foreground mb-3">
                                    {t("compose.event.selectTime", { defaultValue: "Select time" })}
                                </Text>
                                <TextInput
                                    className="text-base p-3 rounded-lg border border-border bg-background text-foreground text-center"
                                    placeholder={t('compose.schedule.time24hPlaceholder')}
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
                            className="text-[15px] p-4 rounded-xl border border-border bg-muted text-foreground min-h-[56px]"
                            placeholder={t("compose.event.locationPlaceholder", {
                                defaultValue: "Location (optional)",
                            })}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={location}
                            onChangeText={onLocationChange}
                            maxLength={200}
                        />

                        <TextInput
                            className="text-[15px] p-4 rounded-xl border border-border bg-muted text-foreground min-h-[120px]"
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
            </View>
        </Dialog>
    );
};
