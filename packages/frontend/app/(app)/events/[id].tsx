import { useState } from 'react';
import { ScrollView, Text, View, Switch } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient, useMutation, useInfiniteQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { EventEditor } from '@/components/Compose/EventEditor';
import { eventsService } from '@/services/eventsService';
import { useSafeBack } from '@/hooks/useSafeBack';
import type { EventState } from '@mention/contracts';

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
function EventDetail({ id, viewerId, signIn }: { id: string; viewerId?: string; signIn(): void }) {
  const { t } = useTranslation();
  const back = useSafeBack();
  const cache = useQueryClient();
  const key = ['event', viewerId ?? null, id];
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
    queryKey: [...key, 'attendees', !!event?.canManage],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      eventsService.attendees(id, !!event?.canManage, !!viewerId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
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
  return (
    <View className="flex-1 bg-background">
      <PageHeader title={text('title', 'Event')} onBack={back} />
      <ScrollView contentContainerClassName="p-4 gap-4 max-w-2xl w-full self-center">
        {query.isPending && (
          <Text className="text-muted-foreground">{text('loading', 'Loading event…')}</Text>
        )}
        {query.isError && (
          <>
            <Text className="text-foreground">
              {text('unavailable', 'This event is unavailable.')}
            </Text>
            <Button onPress={() => query.refetch()}>{text('retry', 'Try again')}</Button>
          </>
        )}
        {event && (
          <>
            <Text className="text-foreground text-2xl font-bold">{event.name}</Text>
            <Text className="text-foreground">{new Date(event.date).toLocaleString()}</Text>
            {!!event.location && <Text className="text-foreground">{event.location}</Text>}
            {!!event.description && <Text className="text-foreground">{event.description}</Text>}
            <Text className="text-muted-foreground">
              {t('events.attendance', {
                defaultValue: '{{count}} attending',
                count: event.attendingCount,
              })}
              {event.capacity !== null ? ` / ${event.capacity}` : ''}
            </Text>
            {event.cancelled && (
              <Text className="text-foreground font-bold">
                {text('cancelled', 'This event has been cancelled.')}
              </Text>
            )}
            {!viewerId ? (
              <Button onPress={signIn}>{text('signIn', 'Sign in to register')}</Button>
            ) : (
              <>
                {(!closed || event.viewerAttendance?.public) && (
                  <>
                    <Text className="text-muted-foreground">
                      {text(
                        'privacy',
                        'Attendance is private by default. Organizers can see the complete attendee list.',
                      )}
                    </Text>
                    <View className="flex-row items-center gap-3">
                      <Switch
                        accessibilityLabel={text('public', 'Show me publicly')}
                        value={publiclyVisible ?? event.viewerAttendance?.public ?? false}
                        onValueChange={(value) => setPubliclyVisible(closed ? false : value)}
                      />
                      <Text className="text-foreground">{text('public', 'Show me publicly')}</Text>
                    </View>
                    {event.viewerAttendance ? (
                      <>
                        <Text className="text-foreground">
                          {event.viewerAttendance.public
                            ? text('visible', 'Your attendance is public.')
                            : text('private', 'Your attendance is private.')}
                        </Text>
                        <Button
                          disabled={
                            busy || (closed && (publiclyVisible ?? event.viewerAttendance.public))
                          }
                          onPress={() => mutation.mutate('visibility')}
                        >
                          {text('saveVisibility', 'Save visibility choice')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        disabled={
                          busy ||
                          (event.capacity !== null && event.attendingCount >= event.capacity)
                        }
                        onPress={() => mutation.mutate('register')}
                      >
                        {text('register', 'Register')}
                      </Button>
                    )}
                  </>
                )}
                {event.viewerAttendance && (
                  <Button disabled={busy} onPress={() => mutation.mutate('withdraw')}>
                    {text('withdraw', 'Cancel my attendance')}
                  </Button>
                )}
              </>
            )}
            <Button onPress={() => setRoster(!roster)}>
              {event.canManage
                ? text('fullRoster', 'View all attendees (organizers only)')
                : text('publicRoster', 'View public attendees')}
            </Button>
            {roster && (
              <>
                {attendees.isError && (
                  <Text className="text-foreground">
                    {text('rosterFailed', 'Could not load attendees.')}
                  </Text>
                )}
                {!attendees.isError &&
                  attendees.data?.pages
                    .flatMap((page) => page.items)
                    .map((attendee) => (
                      <Text key={attendee.oxyUserId} className="text-foreground">
                        {attendee.displayName || text('attendee', 'Attendee')}
                        {!attendee.public ? ` · ${text('privateLabel', 'Private')}` : ''}
                      </Text>
                    ))}
                {attendees.hasNextPage && (
                  <Button disabled={attendees.isFetching} onPress={() => attendees.fetchNextPage()}>
                    {text('more', 'Load more')}
                  </Button>
                )}
              </>
            )}
            {event.canManage && !event.cancelled && (
              <>
                <Button disabled={busy} onPress={startEditing}>
                  {text('edit', 'Edit event')}
                </Button>
                <Button disabled={busy} onPress={() => setConfirmCancel(true)}>
                  {text('cancel', 'Cancel event')}
                </Button>
                {confirmCancel && (
                  <>
                    <Text className="text-foreground">
                      {text(
                        'cancelWarning',
                        'Cancellation is permanent. Attendees will be notified.',
                      )}
                    </Text>
                    <Button disabled={busy} onPress={() => mutation.mutate('cancel')}>
                      {text('confirmCancel', 'Confirm cancellation')}
                    </Button>
                    <Button onPress={() => setConfirmCancel(false)}>
                      {text('keep', 'Keep event')}
                    </Button>
                  </>
                )}
              </>
            )}
            {mutation.isError && (
              <Text accessibilityRole="alert" className="text-foreground">
                {text(
                  'failed',
                  'Could not save. The event may be full, closed, or changed. Refresh and try again.',
                )}
              </Text>
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
        )}
      </ScrollView>
    </View>
  );
}
