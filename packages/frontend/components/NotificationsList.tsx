// Base module for tsc / ESLint resolution.
// At bundle time, Metro resolves NotificationsList.native.tsx (FlashList + the
// LayoutScroll wheel bridge) on native and NotificationsList.web.tsx (window
// virtualizer under the document scroller, no wheel bridge) on web instead.
export { NotificationsList, type NotificationsListProps } from './NotificationsList.web';
