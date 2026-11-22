import type { TFunction } from 'i18next';
import { menuTranslations } from '../postMenuServices';

jest.mock('@/context/CommunityNoteHandlersContext', () => ({}));
jest.mock('@/hooks/useCommunitiesPreview', () => ({}));
jest.mock('../postInteractions', () => ({}));
jest.mock('@oxy.so/services/ui/client', () => ({}));

it('looks each label up once per locale, options included', () => {
  const t = jest.fn((key: string, options?: { count?: number }) =>
    options?.count === undefined ? `[${key}]` : `[${key}:${options.count}]`,
  ) as unknown as jest.Mock & TFunction;
  const menuT = menuTranslations(t);
  for (let row = 0; row < 18; row++) {
    expect(menuT('postActions.save')).toBe('[postActions.save]');
    expect(menuT('post.count', { count: 2 })).toBe('[post.count:2]');
  }
  expect(menuT('post.count', { count: 3 })).toBe('[post.count:3]');
  expect(t).toHaveBeenCalledTimes(3);
});
