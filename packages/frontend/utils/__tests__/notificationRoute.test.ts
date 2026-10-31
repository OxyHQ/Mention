import { notificationSubjectHref } from '../notificationRoute';

it('routes a notification to the subject it names by id, and nothing else', () => {
  expect(notificationSubjectHref({ type: 'like', entityType: 'post', entityId: 'p1' })).toBe(
    '/p/p1',
  );
  expect(notificationSubjectHref({ type: 'reply', entityType: 'reply', entityId: 'r1' })).toBe(
    '/p/r1',
  );
  expect(
    notificationSubjectHref({ type: 'event_cancelled', entityType: 'event', entityId: 'e1' }),
  ).toBe('/events/e1');
  expect(notificationSubjectHref({ type: 'follow', entityType: 'profile', entityId: 'u1' })).toBe(
    null,
  );
  expect(notificationSubjectHref({ type: 'like', entityType: 'post', entityId: '' })).toBe(null);
});
