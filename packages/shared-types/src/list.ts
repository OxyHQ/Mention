// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * List-related types for Mention social network
 */

export enum ListVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

export enum ListType {
  USER = 'user',
  TOPIC = 'topic',
  CURATED = 'curated',
}

export interface List {
  id: string;
  _id?: string;
  name: string;
  description?: string;
  visibility: ListVisibility;
  type: ListType;
  ownerOxyUserId: string; // Links to Oxy user
  isFollowing: boolean;
  memberCount: number;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListMember {
  id: string;
  listId: string;
  oxyUserId: string; // Links to Oxy user
  addedByOxyUserId: string; // Links to Oxy user
  createdAt: string;
}

export interface ListSubscriber {
  id: string;
  listId: string;
  oxyUserId: string; // Links to Oxy user
  createdAt: string;
}

export interface CreateListRequest {
  name: string;
  description?: string;
  visibility: ListVisibility;
  type: ListType;
}

export interface UpdateListRequest {
  name?: string;
  description?: string;
  visibility?: ListVisibility;
}

export interface ListFilters {
  ownerOxyUserId?: string;
  visibility?: ListVisibility;
  type?: ListType;
  isFollowing?: boolean;
  search?: string;
}

export interface ListStats {
  totalLists: number;
  publicLists: number;
  privateLists: number;
  totalMembers: number;
  totalSubscribers: number;
  mostPopularLists: List[];
}
