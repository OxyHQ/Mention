// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { PostSubscriptionListResponse } from '@mention/shared-types';
import { authenticatedClient } from '../utils/api';

class SubscriptionService {
  async getStatus(authorId: string): Promise<{ subscribed: boolean }> {
    const resp = await authenticatedClient.get<{ subscribed: boolean }>(
      `/subscriptions/${authorId}/status`,
    );
    return resp.data;
  }

  async subscribe(authorId: string): Promise<{ subscribed: boolean }> {
    const resp = await authenticatedClient.post<{ subscribed: boolean }>(
      `/subscriptions/${authorId}`,
    );
    return resp.data;
  }

  async unsubscribe(
    authorId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ subscribed: boolean }> {
    const resp = await authenticatedClient.delete<{ subscribed: boolean }>(
      `/subscriptions/${authorId}`,
      options,
    );
    return resp.data;
  }

  /**
   * One page of the viewer's activity subscriptions, newest first. Authors are
   * hydrated server-side, so a row renders straight from the response with no
   * follow-up identity fetch. Omit `cursor` for the first page; pass the previous
   * page's `nextCursor` for the next one — its absence means the end of the list.
   */
  async list(cursor?: string, limit?: number): Promise<PostSubscriptionListResponse> {
    const params: { cursor?: string; limit?: number } = {};
    if (cursor) params.cursor = cursor;
    if (limit !== undefined) params.limit = limit;

    const resp = await authenticatedClient.get<PostSubscriptionListResponse>('/subscriptions', {
      params,
    });
    return resp.data;
  }
}

export const subscriptionService = new SubscriptionService();
