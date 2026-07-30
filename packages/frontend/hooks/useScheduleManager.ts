import { useState, useCallback, createElement, Suspense } from 'react';
import type { TFunction } from 'i18next';
import { toast as toastFn } from '@oxyhq/bloom/toast';
import type { ScheduleOption } from '@/components/Compose/ScheduleSheet';
import type { BottomSheetContextProps } from '@/context/BottomSheetContext';
import { addMinutes } from '@/utils/dateUtils';

interface UseScheduleManagerProps {
  scheduleEnabled: boolean;
  bottomSheet: BottomSheetContextProps;
  t: TFunction;
  toast: typeof toastFn;
}

export const useScheduleManager = ({
  scheduleEnabled,
  bottomSheet,
  t,
  toast,
}: UseScheduleManagerProps) => {
  // The chosen time is state and nothing else. It used to be mirrored into a ref
  // written during render, which the composer read when building the payload —
  // three ways to be wrong at once: the write is illegal input for the React
  // Compiler (it refuses the whole hook over it), the mirror could disagree with
  // the state the "Scheduled for …" toast is built from, and every writer had to
  // remember to update both. `handlePost` is a plain function rebuilt each
  // render, so it already closes over the current value.
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);

  const formatScheduledLabel = useCallback((date: Date) => {
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }, []);

  const clearSchedule = useCallback((options?: { silent?: boolean }) => {
    setScheduledAt(null);
    if (!options?.silent) {
      toast(t('compose.schedule.cleared', { defaultValue: 'Scheduling removed' }), { type: 'success' });
    }
  }, [t, toast]);

  const handleScheduleSelect = useCallback((date: Date) => {
    setScheduledAt(date);
    toast(t('compose.schedule.set', { defaultValue: 'Scheduled for {{time}}', time: formatScheduledLabel(date) }), { type: 'success' });
    bottomSheet.openBottomSheet(false);
  }, [bottomSheet, formatScheduledLabel, t, toast]);

  const handleScheduleClear = useCallback(() => {
    clearSchedule();
    bottomSheet.openBottomSheet(false);
  }, [bottomSheet, clearSchedule]);

  const handleScheduleClose = useCallback(() => {
    bottomSheet.openBottomSheet(false);
  }, [bottomSheet]);

  const getScheduleOptions = useCallback((): ScheduleOption[] => {
    const now = new Date();
    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(now.getDate() + 1);
    tomorrowMorning.setHours(9, 0, 0, 0);

    const laterToday = new Date(now);
    laterToday.setHours(17, 0, 0, 0);
    if (laterToday <= now) {
      laterToday.setDate(laterToday.getDate() + 1);
    }

    return [
      { key: '15m', label: t('compose.schedule.option.15m', { defaultValue: 'In 15 minutes' }), date: addMinutes(now, 15) },
      { key: '1h', label: t('compose.schedule.option.1h', { defaultValue: 'In 1 hour' }), date: addMinutes(now, 60) },
      { key: '3h', label: t('compose.schedule.option.3h', { defaultValue: 'In 3 hours' }), date: addMinutes(now, 180) },
      { key: 'tomorrow', label: t('compose.schedule.option.tomorrow', { defaultValue: 'Tomorrow morning' }), date: tomorrowMorning },
      { key: 'later', label: t('compose.schedule.option.later', { defaultValue: 'Later today' }), date: laterToday },
    ];
  }, [t]);

  const openScheduleSheet = useCallback((ScheduleSheetComponent: React.ComponentType<any>) => {
    if (!scheduleEnabled) {
      toast(t('compose.schedule.singlePostOnly', { defaultValue: 'Scheduling is only available for single posts' }), { type: 'info' });
      return;
    }

    const options = getScheduleOptions();

    bottomSheet.setBottomSheetContent(
      createElement(Suspense, { fallback: null },
        createElement(ScheduleSheetComponent, {
          scheduledAt: scheduledAt,
          options: options,
          onSelect: handleScheduleSelect,
          onClear: handleScheduleClear,
          onClose: handleScheduleClose,
          formatLabel: formatScheduledLabel,
        })
      )
    );
    bottomSheet.openBottomSheet(true);
  }, [
    scheduleEnabled,
    scheduledAt,
    bottomSheet,
    t,
    toast,
    formatScheduledLabel,
    handleScheduleSelect,
    handleScheduleClear,
    handleScheduleClose,
    getScheduleOptions,
  ]);

  return {
    scheduledAt,
    setScheduledAt,
    formatScheduledLabel,
    clearSchedule,
    handleScheduleSelect,
    handleScheduleClear,
    handleScheduleClose,
    openScheduleSheet,
  };
};
