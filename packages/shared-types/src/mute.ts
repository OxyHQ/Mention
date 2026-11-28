// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
