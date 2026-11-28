// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { authenticatedClient } from '@/utils/api';

class ArticleService {
  async getArticle(
    articleId: string,
  ): Promise<{ id: string; postId?: string; title?: string; body?: string }> {
    const response = await authenticatedClient.get<{
      id: string;
      postId?: string;
      title?: string;
      body?: string;
    }>(`/articles/${articleId}`);
    return response.data;
  }
}

export const articleService = new ArticleService();
