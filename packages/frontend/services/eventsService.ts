import {
  EventAttendees,
  EventState,
  EventEdit,
  EventRegistration,
} from '@oxy.so/mention-contracts';
import { authenticatedClient, publicClient } from '@/utils/api';
const path = (id: string) => `/posts/${encodeURIComponent(id)}/event`;
export const eventsService = {
  async get(id: string, authenticated: boolean) {
    const response = authenticated
      ? await authenticatedClient.get(path(id))
      : await publicClient.get(path(id));
    return EventState.parse(response.data);
  },
  async register(id: string, publiclyVisible: boolean) {
    return EventState.parse(
      (
        await authenticatedClient.put(
          `${path(id)}/attendance`,
          EventRegistration.parse({ public: publiclyVisible }),
        )
      ).data,
    );
  },
  async withdraw(id: string) {
    await authenticatedClient.delete(`${path(id)}/attendance`);
  },
  async edit(id: string, input: EventEdit) {
    return EventState.parse((await authenticatedClient.put(path(id), EventEdit.parse(input))).data);
  },
  async cancel(id: string, revision: number) {
    return EventState.parse(
      (await authenticatedClient.post(`${path(id)}/cancel`, { revision })).data,
    );
  },
  async attendees(id: string, full: boolean, authenticated: boolean, cursor?: string) {
    const query = new URLSearchParams({ scope: full ? 'organizers' : 'public' });
    if (cursor) query.set('cursor', cursor);
    const url = `${path(id)}/attendees?${query}`;
    const response = authenticated
      ? await authenticatedClient.get(url)
      : await publicClient.get(url);
    return EventAttendees.parse(response.data);
  },
};
