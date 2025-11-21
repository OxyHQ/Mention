import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export const interests = [
  'animals',
  'art',
  'books',
  'comedy',
  'comics',
  'culture',
  'dev',
  'education',
  'finance',
  'food',
  'gaming',
  'journalism',
  'movies',
  'music',
  'nature',
  'news',
  'pets',
  'photography',
  'politics',
  'science',
  'sports',
  'tech',
  'tv',
  'writers',
] as const;

export type Interest = (typeof interests)[number];

// Most popular selected interests
export const popularInterests = [
  'art',
  'gaming',
  'sports',
  'comics',
  'music',
  'politics',
  'photography',
  'science',
  'news',
] satisfies Interest[];

export function useInterestsDisplayNames() {
  const { t } = useTranslation();

  return useMemo<Record<string, string>>(() => {
    return {
      // Keep this alphabetized
      animals: t('interests.animals', { defaultValue: 'Animals' }),
      art: t('interests.art', { defaultValue: 'Art' }),
      books: t('interests.books', { defaultValue: 'Books' }),
      comedy: t('interests.comedy', { defaultValue: 'Comedy' }),
      comics: t('interests.comics', { defaultValue: 'Comics' }),
      culture: t('interests.culture', { defaultValue: 'Culture' }),
      dev: t('interests.dev', { defaultValue: 'Software Dev' }),
      education: t('interests.education', { defaultValue: 'Education' }),
      finance: t('interests.finance', { defaultValue: 'Finance' }),
      food: t('interests.food', { defaultValue: 'Food' }),
      gaming: t('interests.gaming', { defaultValue: 'Video Games' }),
      journalism: t('interests.journalism', { defaultValue: 'Journalism' }),
      movies: t('interests.movies', { defaultValue: 'Movies' }),
      music: t('interests.music', { defaultValue: 'Music' }),
      nature: t('interests.nature', { defaultValue: 'Nature' }),
      news: t('interests.news', { defaultValue: 'News' }),
      pets: t('interests.pets', { defaultValue: 'Pets' }),
      photography: t('interests.photography', { defaultValue: 'Photography' }),
      politics: t('interests.politics', { defaultValue: 'Politics' }),
      science: t('interests.science', { defaultValue: 'Science' }),
      sports: t('interests.sports', { defaultValue: 'Sports' }),
      tech: t('interests.tech', { defaultValue: 'Tech' }),
      tv: t('interests.tv', { defaultValue: 'TV' }),
      writers: t('interests.writers', { defaultValue: 'Writers' }),
    } satisfies Record<Interest, string>;
  }, [t]);
}





