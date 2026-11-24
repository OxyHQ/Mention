import React from 'react';
import { DatePicker } from '@oxy.so/bloom/date-picker';
import { TextField, TextFieldHint, TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTranslation } from 'react-i18next';
import { formatTimeInput } from '@/utils/dateUtils';
import {
  Button as LButton,
  Dialog as LDialog,
  Embed,
  HStack,
  Text,
  TextEditor,
  TextField as LTextField,
  VStack,
  toElement,
  Field as LField,
} from '@oxy.so/bloom-language';

/** Strict 24h `HH:mm` — `99:99`, `25:00` and half-typed values are not times. */
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

interface EventEditorProps {
  capacity?: string;
  onCapacityChange?: (value: string) => void;
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
  capacity,
  onCapacityChange,
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
  const { t } = useTranslation();
  const invalidCapacity =
    capacity !== undefined &&
    capacity.trim() !== '' &&
    (!/^\d+$/.test(capacity) || Number(capacity) < 1 || Number(capacity) > 1000000);
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
  const eventTime = formatTimeInput(eventDate);

  const handleDateChange = React.useCallback(
    (selectedDate: Date | null) => {
      if (!selectedDate) return;
      // The picker reports midnight of the chosen day; keep the time the
      // user already set on the event.
      const merged = new Date(selectedDate);
      merged.setHours(eventDate.getHours(), eventDate.getMinutes(), eventDate.getSeconds(), 0);
      onDateChange(merged.toISOString());
    },
    [eventDate, onDateChange],
  );

  // The time is TYPED, so what is in the box is not always a time. The draft is
  // kept as typed (never reverted behind the author's back) and only a valid
  // one reaches the event; an invalid one blocks Save and says why.
  const [timeDraft, setTimeDraft] = React.useState(eventTime);
  const [syncedTime, setSyncedTime] = React.useState(eventTime);
  if (syncedTime !== eventTime) {
    setSyncedTime(eventTime);
    setTimeDraft(eventTime);
  }
  const [wasVisible, setWasVisible] = React.useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) setTimeDraft(eventTime);
  }
  const timeInvalid = !TIME_PATTERN.test(timeDraft.trim());

  const handleTimeChange = React.useCallback(
    (text: string) => {
      setTimeDraft(text);
      const match = TIME_PATTERN.exec(text.trim());
      if (!match) return;
      const merged = new Date(eventDate);
      merged.setHours(Number(match[1]), Number(match[2]), 0, 0);
      onDateChange(merged.toISOString());
    },
    [eventDate, onDateChange],
  );

  const handleSave = React.useCallback(() => {
    if (missingName || timeInvalid || invalidCapacity) return;
    onSave();
  }, [missingName, timeInvalid, invalidCapacity, onSave]);

  const saveAction = toElement(
    LButton(Text(t('common.save')))
      .style('solid')
      .tint('accent')
      .size('sm')
      .disabled(missingName || timeInvalid || invalidCapacity)
      .onPress(handleSave)
      .testID('eventEditorSave'),
  );

  return toElement(
    LDialog(
      VStack(
        // No capacity is an empty field: unlimited.
        onCapacityChange
          ? LTextField(
              [capacity ?? '', onCapacityChange],
              t('events.capacity', { defaultValue: 'Capacity (leave empty for unlimited)' }),
            )
              .keyboard('number-pad')
              .testID('eventEditorCapacity')
          : null,
        VStack(
          LTextField(
            [name, onNameChange],
            t('compose.event.namePlaceholder', {
              defaultValue: 'Event name',
            }),
          )
            .maxLength(100)
            .testID('eventEditorName'),
          Embed(
            missingName ? (
              <TextFieldHint>
                {t('compose.event.nameRequired', {
                  defaultValue: 'Give the event a name to attach it.',
                })}
              </TextFieldHint>
            ) : null,
          ),
        ),
        HStack(
          Embed(
            toElement(
              LField(
                t('compose.event.date', { defaultValue: 'Date' }),
                Embed(
                  <DatePicker
                    value={eventDay}
                    onChange={handleDateChange}
                    accessibilityLabel={t('compose.event.date', { defaultValue: 'Date' })}
                    testID="eventEditorDatePicker"
                  />,
                ),
              ).grow(),
            ),
          ),
          VStack(
            Embed(
              <TextField>
                <TextFieldInput
                  label={t('compose.event.time', { defaultValue: 'Time' })}
                  value={timeDraft}
                  onChangeText={handleTimeChange}
                  placeholder="HH:mm"
                  inputMode="numeric"
                  maxLength={5}
                  aria-invalid={timeInvalid || undefined}
                  testID="eventEditorTimeField"
                />
              </TextField>,
            ),
          ).frame({ width: '120' }),
        ).spacing('md'),
        timeInvalid
          ? VStack(
              Embed(
                <TextFieldHint invalid>
                  {t('compose.event.timeInvalid', {
                    defaultValue: 'Enter a valid time, like 20:30.',
                  })}
                </TextFieldHint>,
              ),
            ).testID('eventEditorTimeError')
          : null,
        LTextField(
          [location, onLocationChange],
          t('compose.event.locationPlaceholder', {
            defaultValue: 'Location (optional)',
          }),
        ).maxLength(200),
        TextEditor([description, onDescriptionChange])
          .label(
            t('compose.event.descriptionPlaceholder', {
              defaultValue: 'Description (optional)',
            }),
          )
          .placeholder(
            t('compose.event.descriptionPlaceholder', {
              defaultValue: 'Description (optional)',
            }),
          )
          .rows(4)
          .maxLength(500),
      )
        .padding('bottom', '2xl')
        .spacing('lg'),
    )
      .presentAt('bottom', { md: 'center' })
      .frame({ maxWidth: '640' })
      .maxHeightRatio(0.92)
      .header({
        title: t('compose.event.editorTitle', { defaultValue: 'Create event' }),
        largeTitle: false,
        right: saveAction,
      })
      .testID('eventEditorDialog')
      .presented([visible, () => onClose()]),
  );
};
