import { useState, useCallback, useRef, createElement } from 'react';
import { ScheduleOption } from '@/components/Compose/ScheduleSheet';
import { addMinutes } from '@/utils/dateUtils';

interface UseScheduleManagerProps {
  scheduleEnabled: boolean;
  bottomSheet: any;
  t: any;
  toast: any;
}

export const useScheduleManager = ({
  scheduleEnabled,
  bottomSheet,
  t,
  toast,
}: UseScheduleManagerProps) => {
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const scheduledAtRef = useRef<Date | null>(null);

  // Update ref when state changes
  scheduledAtRef.current = scheduledAt;

  const formatScheduledLabel = useCallback((date: Date) => {
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }, []);

  const clearSchedule = useCallback((options?: { silent?: boolean }) => {
    setScheduledAt(null);
    scheduledAtRef.current = null;
    if (!options?.silent) {
      toast.success(t('compose.schedule.cleared', { defaultValue: 'Scheduling removed' }));
    }
  }, [t, toast]);

  const handleScheduleSelect = useCallback((date: Date) => {
    setScheduledAt(date);
    scheduledAtRef.current = date;
    toast.success(t('compose.schedule.set', { defaultValue: 'Scheduled for {{time}}', time: formatScheduledLabel(date) }));
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
      toast.info(t('compose.schedule.singlePostOnly', { defaultValue: 'Scheduling is only available for single posts' }));
      return;
    }

    const options = getScheduleOptions();

    bottomSheet.setBottomSheetContent(
      createElement(ScheduleSheetComponent, {
        scheduledAt: scheduledAt,
        options: options,
        onSelect: handleScheduleSelect,
        onClear: handleScheduleClear,
        onClose: handleScheduleClose,
        formatLabel: formatScheduledLabel,
      })
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
    scheduledAtRef,
    formatScheduledLabel,
    clearSchedule,
    handleScheduleSelect,
    handleScheduleClear,
    handleScheduleClose,
    openScheduleSheet,
  };
};
