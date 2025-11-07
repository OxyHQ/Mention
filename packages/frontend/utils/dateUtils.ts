/**
 * Date utility functions for scheduling and formatting
 */

export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60000);

export const formatDateInput = (date: Date) => date.toISOString().slice(0, 10);

export const formatTimeInput = (date: Date) => date.toTimeString().slice(0, 5);

export const formatScheduledLabel = (date: Date): string => {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toLocaleString();
  }
};
