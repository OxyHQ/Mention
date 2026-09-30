/**
 * The notification contract validators (`types/validation`), loaded on first use.
 *
 * They are built on zod, whose full entry (every schema class and all ~50 error
 * locales) is ~520 KB of JavaScript to evaluate. The only startup reader was the
 * realtime socket bridge, which mounts on every page but validates nothing until
 * the first event arrives, so the module stays out of the startup path. This is
 * its one `import()`: a second one would make Metro share it between chunks.
 */
export type NotificationValidation = typeof import('@/types/validation');

let loading: Promise<NotificationValidation> | null = null;

export function loadNotificationValidation(): Promise<NotificationValidation> {
  loading ??= import('@/types/validation');
  return loading;
}
