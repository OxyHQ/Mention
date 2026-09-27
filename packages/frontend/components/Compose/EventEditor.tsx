import React from "react";
import { View } from "react-native";
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { DatePicker, TimeField } from '@oxy.so/bloom/date-picker';
import { Field } from '@oxy.so/bloom/field';
import { TextField, TextFieldHint, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTranslation } from "react-i18next";
import { useDatePickerLabels } from "@/hooks/useDatePickerLabels";

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
 * open/close/reopen cycle cannot lose what was typed. The date and time are
 * Bloom's `DatePicker` and `TimeField`, which own their own popup/draft state.
 *
 * An event needs a name to be one. Save stays disabled until it has one and the
 * name field says so — Save used to accept a nameless event and silently attach
 * nothing, which read as a saved event that then could not be posted.
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
    const { t, i18n } = useTranslation();
    const datePickerLabels = useDatePickerLabels();
    const missingName = name.trim().length === 0;
    const eventDate = React.useMemo(() => {
        const parsed = date ? new Date(date) : new Date();
        return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    }, [date]);

    // Bloom's pickers speak local-midnight days and 24h "HH:mm" times; the
    // stored value stays one ISO timestamp, so each half merges into the other.
    const eventDay = React.useMemo(
        () => new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate()),
        [eventDate],
    );
    const eventTime = `${String(eventDate.getHours()).padStart(2, '0')}:${String(eventDate.getMinutes()).padStart(2, '0')}`;

    const handleDateChange = React.useCallback((selectedDate: Date | null) => {
        if (!selectedDate) return;
        // The picker reports midnight of the chosen day; keep the time the
        // user already set on the event.
        const merged = new Date(selectedDate);
        merged.setHours(eventDate.getHours(), eventDate.getMinutes(), eventDate.getSeconds(), 0);
        onDateChange(merged.toISOString());
    }, [eventDate, onDateChange]);

    const handleTimeChange = React.useCallback((time: string | null) => {
        if (!time) return;
        const [hours, minutes] = time.split(':').map(Number);
        const merged = new Date(eventDate);
        merged.setHours(hours, minutes);
        onDateChange(merged.toISOString());
    }, [eventDate, onDateChange]);

    const saveAction = (
        <Button
            appearance="solid"
            tone="accent"
            size="small"
            disabled={missingName}
            onPress={onSave}
            testID="eventEditorSave"
        >
            {t("common.save")}
        </Button>
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
                <View>
                    <TextField>
                        <TextFieldInput
                            label={t("compose.event.namePlaceholder", {
                                defaultValue: "Event name",
                            })}
                            value={name}
                            onChangeText={onNameChange}
                            maxLength={100}
                            testID="eventEditorName"
                        />
                    </TextField>
                    {missingName ? (
                        <TextFieldHint>
                            {t("compose.event.nameRequired", {
                                defaultValue: "Give the event a name to attach it.",
                            })}
                        </TextFieldHint>
                    ) : null}
                </View>

                <View className="flex-row gap-3">
                    <Field
                        label={t("compose.event.date", { defaultValue: "Date" })}
                        style={{ flex: 1 }}
                    >
                        <DatePicker
                            value={eventDay}
                            onChange={handleDateChange}
                            locale={i18n.language}
                            labels={datePickerLabels}
                            accessibilityLabel={t("compose.event.date", { defaultValue: "Date" })}
                            testID="eventEditorDatePicker"
                        />
                    </Field>

                    <Field label={t("compose.event.time", { defaultValue: "Time" })}>
                        <TimeField
                            value={eventTime}
                            onChange={handleTimeChange}
                            testID="eventEditorTimeField"
                        />
                    </Field>
                </View>

                <TextFieldInput
                    label={t("compose.event.locationPlaceholder", {
                        defaultValue: "Location (optional)",
                    })}
                    value={location}
                    onChangeText={onLocationChange}
                    maxLength={200}
                />

                <Textarea
                    accessibilityLabel={t("compose.event.descriptionPlaceholder", {
                        defaultValue: "Description (optional)",
                    })}
                    placeholder={t("compose.event.descriptionPlaceholder", {
                        defaultValue: "Description (optional)",
                    })}
                    value={description}
                    onChangeText={onDescriptionChange}
                    rows={4}
                    maxLength={500}
                />
            </View>
        </Dialog>
    );
};
