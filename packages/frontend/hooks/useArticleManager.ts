// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useState, useCallback } from 'react';

export interface ArticleData {
  title: string;
  body: string;
}

export const useArticleManager = () => {
  const [article, setArticle] = useState<ArticleData | null>(null);
  const [isArticleEditorVisible, setIsArticleEditorVisible] = useState(false);
  const [articleDraftTitle, setArticleDraftTitle] = useState('');
  const [articleDraftBody, setArticleDraftBody] = useState('');

  const openArticleEditor = useCallback(() => {
    setArticleDraftTitle(article?.title || '');
    setArticleDraftBody(article?.body || '');
    setIsArticleEditorVisible(true);
  }, [article]);

  const closeArticleEditor = useCallback(() => {
    setIsArticleEditorVisible(false);
  }, []);

  const saveArticle = useCallback(() => {
    const title = articleDraftTitle.trim();
    const body = articleDraftBody.trim();
    if (!title && !body) {
      setArticle(null);
    } else {
      setArticle({ title, body });
    }
    setIsArticleEditorVisible(false);
  }, [articleDraftTitle, articleDraftBody]);

  const removeArticle = useCallback(() => {
    setArticle(null);
    setArticleDraftTitle('');
    setArticleDraftBody('');
  }, []);

  const loadArticleFromDraft = useCallback((draftArticle: ArticleData | null) => {
    setArticle(draftArticle);
  }, []);

  const clearArticle = useCallback(() => {
    setArticle(null);
    setArticleDraftTitle('');
    setArticleDraftBody('');
    setIsArticleEditorVisible(false);
  }, []);

  return {
    article,
    setArticle,
    isArticleEditorVisible,
    articleDraftTitle,
    setArticleDraftTitle,
    articleDraftBody,
    setArticleDraftBody,
    openArticleEditor,
    closeArticleEditor,
    saveArticle,
    removeArticle,
    loadArticleFromDraft,
    clearArticle,
  };
};
