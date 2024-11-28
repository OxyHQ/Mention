"use client";
import React, { useEffect, useState } from "react";
import { useLocale } from "@/app/LocaleContext";

const LanguageSwitcher = () => {
  const { locale, setLocale } = useLocale();
  const [translations, setTranslations] = useState([]);

  const changeLanguage = async (event: { target: { value: string } }) => {
    const newLocale = event.target.value;
    setLocale(newLocale);

    // Fetch translations for the selected language
    const response = await fetch(`/api/posts?language=${newLocale}`);
    const data = await response.json();
    setTranslations(data.posts);
  };

  useEffect(() => {
    // Fetch translations for the initial language
    const fetchTranslations = async () => {
      const response = await fetch(`/api/posts?language=${locale}`);
      const data = await response.json();
      setTranslations(data.posts);
    };

    fetchTranslations();
  }, [locale]);

  return (
    <div>
      <select value={locale} onChange={changeLanguage}>
        <option value="en">English</option>
        <option value="es">Español</option>
        <option value="fr">Français</option>
        <option value="de">Deutsch</option>
        <option value="it">Italiano</option>
        <option value="pt">Português</option>
        <option value="ru">Русский</option>
        <option value="zh">中文</option>
        <option value="ja">日本語</option>
        <option value="ko">한국어</option>
      </select>

      <div>
        {translations.map((post) => (
          <div key={post.id}>
            <h3>{post.author.name}</h3>
            <p>{post.translations[0]?.translatedText || post.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default LanguageSwitcher;
