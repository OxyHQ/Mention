import { useState, useCallback } from "react";

export interface ArticleData {
  title: string;
  body: string;
}

export const useArticleManager = () => {
  const [article, setArticle] = useState<ArticleData | null>(null);
  const [isArticleEditorVisible, setIsArticleEditorVisible] = useState(false);
  const [articleDraftTitle, setArticleDraftTitle] = useState("");
  const [articleDraftBody, setArticleDraftBody] = useState("");

  const openArticleEditor = useCallback(() => {
    setArticleDraftTitle(article?.title || "");
    setArticleDraftBody(article?.body || "");
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
    setArticleDraftTitle("");
    setArticleDraftBody("");
  }, []);

  const loadArticleFromDraft = useCallback((draftArticle: ArticleData | null) => {
    setArticle(draftArticle);
  }, []);

  const clearArticle = useCallback(() => {
    setArticle(null);
    setArticleDraftTitle("");
    setArticleDraftBody("");
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
