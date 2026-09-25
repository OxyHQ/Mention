/**
 * The copy OxyHQ/Mention#1140 found wrong, read through a REAL i18next with the
 * shipped catalogs rather than a key-echoing mock — the defects were in what the
 * catalogs said and how they pluralised, which a mock cannot see.
 *
 *  - An empty thread read "No posts yet" over "No replies yet. Be the first to
 *    reply!" — two headlines, in English only.
 *  - Counters read "1 Boosts", "1 Replies".
 */
import i18next, { type TFunction } from 'i18next';
import en from '@/locales/en.json';
import ru from '@/locales/ru.json';
import { emptyCopy } from '../FeedEmptyState';

jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: 'EmptyState' }));
jest.mock('@/components/ui/Spinner', () => ({ Spinner: 'Spinner' }));

let t: TFunction;
let tRu: TFunction;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  });
  t = instance.getFixedT('en');
  tRu = instance.getFixedT('ru');
});

describe('empty feed copy', () => {
  it('an empty THREAD says one thing, about replies, and invites one', () => {
    expect(emptyCopy(t, 'replies', { isThread: true })).toEqual({
      title: 'No replies yet',
      subtitle: 'Be the first to reply!',
    });
  });

  it('a profile’s Replies tab does not invite a reply to nothing', () => {
    const copy = emptyCopy(t, 'replies');
    expect(copy.title).toBe('No replies yet');
    expect(copy.subtitle).not.toMatch(/first to reply/i);
  });

  it('never titles a non-post list "No posts yet"', () => {
    for (const type of ['replies', 'boosts', 'likes', 'media', 'mentions'] as const) {
      expect(emptyCopy(t, type).title).not.toBe('No posts yet');
    }
    expect(emptyCopy(t, 'for_you', { showOnlySaved: true }).title).toBe('No saved posts yet');
  });

  it('gives the profile mentions tab its own copy', () => {
    expect(emptyCopy(t, 'mentions')).toEqual({
      title: 'No mentions yet',
      subtitle: 'Posts that mention this account will show up here.',
    });
  });

  it('is translated, not English', () => {
    const copy = emptyCopy(tRu, 'replies', { isThread: true });
    expect(copy.title).toBe('Ответов пока нет');
    expect(copy.subtitle).not.toBe('Be the first to reply!');
  });
});

describe('counter labels follow the language’s plural rules', () => {
  it('reads "1 Boost", "1 Reply", "1 Post" in English, and the plural otherwise', () => {
    expect(t('profile.stats.boosts', { count: 1 })).toBe('Boost');
    expect(t('profile.stats.boosts', { count: 2 })).toBe('Boosts');
    expect(t('profile.stats.replies', { count: 1 })).toBe('Reply');
    expect(t('profile.stats.replies', { count: 0 })).toBe('Replies');
    expect(t('profile.stats.posts', { count: 1 })).toBe('Post');
    expect(t('profile.stats.posts', { count: 7 })).toBe('Posts');
  });

  it('pluralises the action row’s reply summary', () => {
    expect(t('post.summary.replies', { count: 1, formattedCount: '1' })).toBe('1 reply');
    expect(t('post.summary.replies', { count: 1200, formattedCount: '1.2K' })).toBe('1.2K replies');
  });

  it('uses every Russian category, not an English one/other split', () => {
    expect(tRu('profile.stats.replies', { count: 1 })).toBe('Ответ');
    expect(tRu('profile.stats.replies', { count: 3 })).toBe('Ответа');
    expect(tRu('profile.stats.replies', { count: 5 })).toBe('Ответов');
  });
});
