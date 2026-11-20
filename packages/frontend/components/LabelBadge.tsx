export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type LabelActionType = 'show' | 'warn' | 'blur' | 'hide';

/** Raw severity swatches, read by the labeler detail screen (`app/(app)/moderation/labelers/[id].tsx`). */
export const SEVERITY_COLORS: Record<Severity, string> = {
  low: '#6b7280',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
};
