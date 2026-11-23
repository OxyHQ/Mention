import { useState } from 'react';
import { Switch } from 'react-native';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useQuery, useQueryClient, useMutation, useInfiniteQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { nextUnvisitedCursor } from '@oxy.so/utils/paging';
import { EventEditor } from '@/components/Compose/EventEditor';
import { eventsService } from '@/services/eventsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { EventState } from '@oxy.so/mention-contracts';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  RawText,
  ScrollView,
  Text as LText,
  toElement,
  Embed as LEmbed,
} from '@oxy.so/bloom-language';

import { screen } from '@oxy.so/bloom-language/router';

/** Viewer-scoped data stays on the detail screen and never in the feed cache. */
export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, signIn } = useAuth();
  // Account switching remounts the private state, including roster and editor.
  return (
    <EventDetail
      key={`${id}:${user?.id ?? 'anon'}`}
      id={String(id)}
      viewerId={user?.id}
      signIn={() => {
        void signIn();
      }}
    />
  );
}

const EventDetail = screen(function EventDetail({
  id,
  viewerId,
  signIn,
}: {
  id: string;
  viewerId?: string;
  signIn(): void;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const key = viewerQueryKeys.event(viewerId, id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => eventsService.get(id, !!viewerId),
    staleTime: 0,
    gcTime: 0,
  });
  const event = query.isError ? undefined : query.data;
  const [publiclyVisible, setPubliclyVisible] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<EventState | null>(null);
  const [capacity, setCapacity] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [roster, setRoster] = useState(false);
  const attendees = useInfiniteQuery({
    queryKey: viewerQueryKeys.eventAttendees(viewerId, id, !!event?.canManage),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      eventsService.attendees(id, !!event?.canManage, !!viewerId, pageParam),
    getNextPageParam: (page, _pages, _pageParam, pageParams) =>
      nextUnvisitedCursor(page.nextCursor, pageParams),
    enabled: roster && !!event,
    staleTime: 0,
    gcTime: 0,
  });
  const mutation = useMutation({
    mutationFn: async (command: 'register' | 'withdraw' | 'visibility' | 'edit' | 'cancel') => {
      if (command === 'withdraw') return eventsService.withdraw(id);
      if (command === 'register' || command === 'visibility')
        return eventsService.register(
          id,
          publiclyVisible ?? event?.viewerAttendance?.public ?? false,
        );
      if (command === 'cancel') return eventsService.cancel(id, event!.revision);
      return eventsService.edit(id, {
        name: editing!.name,
        date: editing!.date,
        location: editing!.location,
        description: editing!.description,
        capacity: capacity.trim() ? Number(capacity) : null,
        revision: editing!.revision,
      });
    },
    onSuccess: async () => {
      setEditing(null);
      setConfirmCancel(false);
      await cache.invalidateQueries({ queryKey: key });
    },
    onError: async () => {
      await cache.invalidateQueries({ queryKey: key });
    },
  });
  const text = (key: string, defaultValue: string) => t(`events.${key}`, { defaultValue });
  const busy = mutation.isPending;
  const closed = !!event && (event.cancelled || new Date(event.date).getTime() <= Date.now());
  const startEditing = () => {
    if (event) {
      setEditing(event);
      setCapacity(event.capacity === null ? '' : String(event.capacity));
    }
  };
  return LEmbed(
    toElement(
      ScrollView(
        Embed(
          query.isPending &&
            toElement(RawText(text('loading', 'Loading event…')).foreground('muted')),
        ),
        Embed(
          query.isError && (
            <>
              {toElement(
                RawText(text('unavailable', 'This event is unavailable.')).foreground('foreground'),
              )}
              {toElement(LButton(LText(text('retry', 'Try again'))).onPress(() => query.refetch()))}
            </>
          ),
        ),
        Embed(
          event && (
            <>
              {toElement(
                RawText(event.name)
                  .foreground('foreground')
                  .font('24')
                  .leading('32px')
                  .weight('bold'),
              )}
              {toElement(RawText(new Date(event.date).toLocaleString()).foreground('foreground'))}
              {!!event.location && toElement(RawText(event.location).foreground('foreground'))}
              {!!event.description &&
                toElement(RawText(event.description).foreground('foreground'))}
              {toElement(
                RawText(
                  t('events.attendance', {
                    defaultValue: '{{count}} attending',
                    count: event.attendingCount,
                  }),
                  event.capacity !== null ? ` / ${event.capacity}` : '',
                ).foreground('muted'),
              )}
              {event.cancelled &&
                toElement(
                  RawText(text('cancelled', 'This event has been cancelled.'))
                    .foreground('foreground')
                    .weight('bold'),
                )}
              {!viewerId ? (
                toElement(LButton(LText(text('signIn', 'Sign in to register'))).onPress(signIn))
              ) : (
                <>
                  {(!closed || event.viewerAttendance?.public) && (
                    <>
                      {toElement(
                        RawText(
                          text(
                            'privacy',
                            'Attendance is private by default. Organizers can see the complete attendee list.',
                          ),
                        ).foreground('muted'),
                      )}
                      {toElement(
                        HStack(
                          Embed(
                            <Switch
                              accessibilityLabel={text('public', 'Show me publicly')}
                              value={publiclyVisible ?? event.viewerAttendance?.public ?? false}
                              onValueChange={(value) => setPubliclyVisible(closed ? false : value)}
                            />,
                          ),
                          RawText(text('public', 'Show me publicly')).foreground('foreground'),
                        )
                          .align('center')
                          .spacing('md'),
                      )}
                      {event.viewerAttendance ? (
                        <>
                          {toElement(
                            RawText(
                              event.viewerAttendance.public
                                ? text('visible', 'Your attendance is public.')
                                : text('private', 'Your attendance is private.'),
                            ).foreground('foreground'),
                          )}
                          {toElement(
                            LButton(LText(text('saveVisibility', 'Save visibility choice')))
                              .disabled(
                                busy ||
                                  (closed && (publiclyVisible ?? event.viewerAttendance.public)),
                              )
                              .onPress(() => mutation.mutate('visibility')),
                          )}
                        </>
                      ) : (
                        toElement(
                          LButton(LText(text('register', 'Register')))
                            .disabled(
                              busy ||
                                (event.capacity !== null && event.attendingCount >= event.capacity),
                            )
                            .onPress(() => mutation.mutate('register')),
                        )
                      )}
                    </>
                  )}
                  {event.viewerAttendance &&
                    toElement(
                      LButton(LText(text('withdraw', 'Cancel my attendance')))
                        .disabled(busy)
                        .onPress(() => mutation.mutate('withdraw')),
                    )}
                </>
              )}
              {toElement(
                LButton(
                  LText(
                    event.canManage
                      ? text('fullRoster', 'View all attendees (organizers only)')
                      : text('publicRoster', 'View public attendees'),
                  ),
                ).onPress(() => setRoster(!roster)),
              )}
              {roster && (
                <>
                  {attendees.isError &&
                    toElement(
                      RawText(text('rosterFailed', 'Could not load attendees.')).foreground(
                        'foreground',
                      ),
                    )}
                  {!attendees.isError &&
                    attendees.data?.pages
                      .flatMap((page) => page.items)
                      .map((attendee) =>
                        toElement(
                          RawText(
                            attendee.displayName || text('attendee', 'Attendee'),
                            !attendee.public ? ` · ${text('privateLabel', 'Private')}` : '',
                          ).foreground('foreground'),
                          attendee.oxyUserId,
                        ),
                      )}
                  {attendees.hasNextPage &&
                    toElement(
                      LButton(LText(text('more', 'Load more')))
                        .disabled(attendees.isFetching)
                        .onPress(() => attendees.fetchNextPage()),
                    )}
                </>
              )}
              {event.canManage && !event.cancelled && (
                <>
                  {toElement(
                    LButton(LText(text('edit', 'Edit event')))
                      .disabled(busy)
                      .onPress(startEditing),
                  )}
                  {toElement(
                    LButton(LText(text('cancel', 'Cancel event')))
                      .disabled(busy)
                      .onPress(() => setConfirmCancel(true)),
                  )}
                  {confirmCancel && (
                    <>
                      {toElement(
                        RawText(
                          text(
                            'cancelWarning',
                            'Cancellation is permanent. Attendees will be notified.',
                          ),
                        ).foreground('foreground'),
                      )}
                      {toElement(
                        LButton(LText(text('confirmCancel', 'Confirm cancellation')))
                          .disabled(busy)
                          .onPress(() => mutation.mutate('cancel')),
                      )}
                      {toElement(
                        LButton(LText(text('keep', 'Keep event'))).onPress(() =>
                          setConfirmCancel(false),
                        ),
                      )}
                    </>
                  )}
                </>
              )}
              {mutation.isError &&
                toElement(
                  RawText(
                    text(
                      'failed',
                      'Could not save. The event may be full, closed, or changed. Refresh and try again.',
                    ),
                  )
                    .foreground('foreground')
                    .role('alert'),
                )}
              {editing && (
                <>
                  <EventEditor
                    visible
                    name={editing.name}
                    date={editing.date}
                    location={editing.location ?? ''}
                    description={editing.description ?? ''}
                    onNameChange={(name) => setEditing({ ...editing, name })}
                    onDateChange={(date) => setEditing({ ...editing, date })}
                    onLocationChange={(location) => setEditing({ ...editing, location })}
                    onDescriptionChange={(description) => setEditing({ ...editing, description })}
                    capacity={capacity}
                    onCapacityChange={setCapacity}
                    onClose={() => setEditing(null)}
                    onSave={() => {
                      if (!busy) mutation.mutate('edit');
                    }}
                  />
                </>
              )}
            </>
          ),
        ),
      ).contentView((v) =>
        v
          .padding('all', 'lg')
          .frame({ maxWidth: '672', width: 'full' })
          .spacing('lg')
          .alignSelf('center'),
      ),
    ),
  ).header(LEmbed(toElement(Header(text('title', 'Event')).inPage())));
});
