# Post Subscriptions (Profile Bell)

This feature lets a user subscribe to another user's new posts from the profile header bell icon.

Backend:
- Model: `PostSubscription { subscriberId, authorId }` with unique index.
- Routes (all under `/api/subscriptions`):
  - `GET /:authorId/status` → `{ subscribed: boolean }`
  - `POST /:authorId` → subscribe
  - `DELETE /:authorId` → unsubscribe
- Post creation now notifies subscribers with Notification type `post`.

Frontend:
- Service: `services/subscriptionService.ts`
- UI: `components/ProfileScreen.tsx` toggles the bell (outline vs filled) using the service. Optimistic update with rollback on error.

Notes:
- Push notifications and real-time sockets reuse existing infrastructure.
- Only top-level posts trigger subscriber notifications (replies do not).
