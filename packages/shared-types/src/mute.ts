/** A local user mute as serialized by Mention's /mute API. */
export interface SerializedMute {
  _id: string;
  userId: string;
  mutedId: string;
  createdAt: string;
}

export interface MutedUsersResponse {
  mutes: SerializedMute[];
  count: number;
}
