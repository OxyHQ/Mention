// Types only: the contracts are Zod schemas, and zod's one way into the app is
// `lib/notificationValidation`. The API validates every command it receives.
import type { EventAttendees, EventEdit, EventState } from '@oxy.so/mention-contracts';
import type { z } from 'zod';
import { authenticatedClient, publicClient } from '@/utils/api';

type EventAttendeesPage = z.infer<typeof EventAttendees>;

const path = (id: string) => `/posts/${encodeURIComponent(id)}/event`;
export const eventsService = {
  async get(id: string, authenticated: boolean): Promise<EventState> {
    const response = authenticated
      ? await authenticatedClient.get<EventState>(path(id))
      : await publicClient.get<EventState>(path(id));
    return response.data;
  },
  async register(id: string, publiclyVisible: boolean): Promise<EventState> {
    return (
      await authenticatedClient.put<EventState>(`${path(id)}/attendance`, {
        public: publiclyVisible,
      })
    ).data;
  },
  async withdraw(id: string) {
    await authenticatedClient.delete(`${path(id)}/attendance`);
  },
  async edit(id: string, input: EventEdit): Promise<EventState> {
    return (await authenticatedClient.put<EventState>(path(id), input)).data;
  },
  async cancel(id: string, revision: number): Promise<EventState> {
    return (await authenticatedClient.post<EventState>(`${path(id)}/cancel`, { revision })).data;
  },
  async attendees(
    id: string,
    full: boolean,
    authenticated: boolean,
    cursor?: string,
  ): Promise<EventAttendeesPage> {
    const query = new URLSearchParams({ scope: full ? 'organizers' : 'public' });
    if (cursor) query.set('cursor', cursor);
    const url = `${path(id)}/attendees?${query}`;
    const response = authenticated
      ? await authenticatedClient.get<EventAttendeesPage>(url)
      : await publicClient.get<EventAttendeesPage>(url);
    return response.data;
  },
};
