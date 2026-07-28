import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ChevronLeftIcon } from '@/assets/icons/chevron-left-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { cn } from '@/lib/utils';

const MONTHS_IN_YEAR = 12;
const DAYS_IN_WEEK = 7;
/** Always render six rows so the grid keeps a stable height across months. */
const WEEK_ROWS = 6;
const YEARS_PER_PAGE = 12;

type CalendarView = 'days' | 'months' | 'years';

/** How far the header arrows move for each pane. */
const VIEW_STEP_MONTHS: Record<CalendarView, number> = {
  days: 1,
  months: MONTHS_IN_YEAR,
  years: MONTHS_IN_YEAR * YEARS_PER_PAGE,
};

/** Tapping the header title zooms out, then back to the day grid. */
const NEXT_VIEW: Record<CalendarView, CalendarView> = {
  days: 'months',
  months: 'years',
  years: 'days',
};

type DayCell = { day: number; isToday: boolean } | null;

interface CalendarProps {
  /** Selected day. Only its calendar date is read — the caller owns the time. */
  value: Date;
  /** Fires with midnight of the tapped day, in the device time zone. */
  onChange: (date: Date) => void;
}

/**
 * Inline month calendar built on React Native primitives.
 *
 * It replaces `react-native-ui-datepicker`, which dragged a full `lodash` copy
 * plus `dayjs` and its jalali plugin into the bundle — roughly 640 KB of Hermes
 * bytecode for one date field. Month, weekday and title labels come from `Intl`
 * so localization follows the app language on iOS, Android and web without
 * shipping a date library.
 */
export const Calendar: React.FC<CalendarProps> = ({ value, onChange }) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  // A single integer (year * 12 + month) is the whole navigation state: it makes
  // stepping by month, year or year-page plain arithmetic.
  const selectedMonthIndex = value.getFullYear() * MONTHS_IN_YEAR + value.getMonth();
  const [syncedMonthIndex, setSyncedMonthIndex] = React.useState(selectedMonthIndex);
  const [visibleMonthIndex, setVisibleMonthIndex] = React.useState(selectedMonthIndex);
  const [view, setView] = React.useState<CalendarView>('days');

  // Re-centre on the selection when the controlled value moves to another month.
  // Adjusting state during render is React's documented alternative to an effect.
  if (syncedMonthIndex !== selectedMonthIndex) {
    setSyncedMonthIndex(selectedMonthIndex);
    setVisibleMonthIndex(selectedMonthIndex);
    setView('days');
  }

  const visibleYear = Math.floor(visibleMonthIndex / MONTHS_IN_YEAR);
  const visibleMonth = visibleMonthIndex - visibleYear * MONTHS_IN_YEAR;
  const yearPageStart = visibleYear - (visibleYear % YEARS_PER_PAGE);

  const weekdayLabels = React.useMemo(() => {
    // 4 January 1970 (UTC) was a Sunday, and the formatter is pinned to UTC so
    // the label never slides a day in negative-offset time zones.
    const format = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' });
    return Array.from({ length: DAYS_IN_WEEK }, (_, index) =>
      format.format(new Date(Date.UTC(1970, 0, 4 + index))),
    );
  }, [locale]);

  const monthLabels = React.useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { month: 'short' });
    return Array.from({ length: MONTHS_IN_YEAR }, (_, index) =>
      format.format(new Date(visibleYear, index, 1)),
    );
  }, [locale, visibleYear]);

  const headerTitle = React.useMemo(() => {
    if (view === 'months') return String(visibleYear);
    if (view === 'years') return `${yearPageStart}–${yearPageStart + YEARS_PER_PAGE - 1}`;
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
      new Date(visibleYear, visibleMonth, 1),
    );
  }, [view, locale, visibleYear, visibleMonth, yearPageStart]);

  const weeks = React.useMemo<DayCell[][]>(() => {
    const leadingBlanks = new Date(visibleYear, visibleMonth, 1).getDay();
    const daysInMonth = new Date(visibleYear, visibleMonth + 1, 0).getDate();
    // Today is resolved once per visible month rather than per cell; the ring
    // only has to be right for as long as that month stays on screen.
    const today = new Date();
    const todayDay =
      today.getFullYear() === visibleYear && today.getMonth() === visibleMonth
        ? today.getDate()
        : 0;

    return Array.from({ length: WEEK_ROWS }, (_, row) =>
      Array.from({ length: DAYS_IN_WEEK }, (_, column) => {
        const day = row * DAYS_IN_WEEK + column - leadingBlanks + 1;
        return day >= 1 && day <= daysInMonth ? { day, isToday: day === todayDay } : null;
      }),
    );
  }, [visibleYear, visibleMonth]);

  const shiftPeriod = React.useCallback(
    (direction: 1 | -1) => {
      setVisibleMonthIndex((current) => current + direction * VIEW_STEP_MONTHS[view]);
    },
    [view],
  );

  const selectedYear = value.getFullYear();
  const selectedMonth = value.getMonth();
  const selectedDay = value.getDate();
  const isSelectedMonthVisible = selectedYear === visibleYear && selectedMonth === visibleMonth;

  return (
    <View>
      <View className="flex-row items-center justify-between mb-2">
        <TouchableOpacity
          onPress={() => shiftPeriod(-1)}
          accessibilityRole="button"
          accessibilityLabel={t('calendar.previous', { defaultValue: 'Previous' })}
          className="w-10 h-10 items-center justify-center rounded-full"
          activeOpacity={0.7}
        >
          <ChevronLeftIcon size={22} className="text-foreground" />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setView(NEXT_VIEW[view])}
          accessibilityRole="button"
          className="px-3 py-2 rounded-full"
          activeOpacity={0.7}
        >
          <Text className="text-base font-semibold text-foreground">{headerTitle}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => shiftPeriod(1)}
          accessibilityRole="button"
          accessibilityLabel={t('calendar.next', { defaultValue: 'Next' })}
          className="w-10 h-10 items-center justify-center rounded-full"
          activeOpacity={0.7}
        >
          <ChevronRightIcon size={22} className="text-foreground" />
        </TouchableOpacity>
      </View>

      {view === 'days' && (
        <View>
          <View className="flex-row mb-1">
            {weekdayLabels.map((label, index) => (
              <Text
                key={`weekday-${index}`}
                className="flex-1 text-center text-xs font-medium text-muted-foreground"
              >
                {label}
              </Text>
            ))}
          </View>

          {weeks.map((week, row) => (
            <View key={`week-${row}`} className="flex-row">
              {week.map((cell, column) => {
                if (!cell) {
                  return <View key={`empty-${row}-${column}`} className="flex-1 aspect-square" />;
                }
                const isSelected = isSelectedMonthVisible && cell.day === selectedDay;
                return (
                  <TouchableOpacity
                    key={`day-${cell.day}`}
                    onPress={() => onChange(new Date(visibleYear, visibleMonth, cell.day))}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    className="flex-1 aspect-square p-0.5"
                    activeOpacity={0.7}
                  >
                    <View
                      className={cn(
                        'flex-1 items-center justify-center rounded-full',
                        isSelected && 'bg-primary',
                      )}
                    >
                      <Text
                        className={cn(
                          'text-[15px]',
                          isSelected
                            ? 'font-semibold text-primary-foreground'
                            : cell.isToday
                              ? 'font-semibold text-primary'
                              : 'text-foreground',
                        )}
                      >
                        {cell.day}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>
      )}

      {view === 'months' && (
        <View className="flex-row flex-wrap">
          {monthLabels.map((label, month) => (
            <TouchableOpacity
              key={label}
              onPress={() => {
                setVisibleMonthIndex(visibleYear * MONTHS_IN_YEAR + month);
                setView('days');
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedYear === visibleYear && selectedMonth === month }}
              className="w-1/3 p-1"
              activeOpacity={0.7}
            >
              <View
                className={cn(
                  'py-3 items-center justify-center rounded-xl',
                  selectedYear === visibleYear && selectedMonth === month && 'bg-primary',
                )}
              >
                <Text
                  className={cn(
                    'text-[15px]',
                    selectedYear === visibleYear && selectedMonth === month
                      ? 'font-semibold text-primary-foreground'
                      : 'text-foreground',
                  )}
                >
                  {label}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {view === 'years' && (
        <View className="flex-row flex-wrap">
          {Array.from({ length: YEARS_PER_PAGE }, (_, index) => yearPageStart + index).map((year) => (
            <TouchableOpacity
              key={year}
              onPress={() => {
                setVisibleMonthIndex(year * MONTHS_IN_YEAR + visibleMonth);
                setView('months');
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: year === selectedYear }}
              className="w-1/3 p-1"
              activeOpacity={0.7}
            >
              <View
                className={cn(
                  'py-3 items-center justify-center rounded-xl',
                  year === selectedYear && 'bg-primary',
                )}
              >
                <Text
                  className={cn(
                    'text-[15px]',
                    year === selectedYear
                      ? 'font-semibold text-primary-foreground'
                      : 'text-foreground',
                  )}
                >
                  {year}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
};
