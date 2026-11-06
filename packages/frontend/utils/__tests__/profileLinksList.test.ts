import type { RemoteProfileField } from '@mention/shared-types/profile';
import { nonLinkFields, profileLinksList } from '../profileLinksList';

const field = (name: string, value: string): RemoteProfileField => ({ name, value });

describe('profileLinksList', () => {
  it('turns a link-valued remote field into a pill titled by the field name', () => {
    const links = profileLinksList({
      fields: [field('YouTube', 'https://youtube.com/@minakimes')],
    });

    expect(links).toEqual([
      { id: 'field-0', url: 'https://youtube.com/@minakimes', title: 'YouTube' },
    ]);
  });

  it('shows a link once when the bio and a field name the same page', () => {
    const links = profileLinksList({
      bio: 'Mi web https://example.com',
      fields: [field('Web', 'https://www.example.com/')],
    });

    expect(links.map((link) => link.url)).toEqual(['https://example.com']);
  });
});

describe('nonLinkFields', () => {
  it('keeps the fields that carry no link as metadata rows', () => {
    const fields = [field('Pronouns', 'they/them'), field('YouTube', 'https://youtube.com/x')];

    expect(nonLinkFields(fields)).toEqual([field('Pronouns', 'they/them')]);
  });
});
